/**
 * FSRS parameter optimisation (spec 0013), like Anki's "Optimize": fit the 21 FSRS-6 weights to this
 * collection's own review history. Pure and tested.
 *
 * The memory model below is ts-fsrs's FSRS-6 (`next_state`, `forgetting_curve`) written out inline
 * so a training pass over tens of thousands of reviews takes milliseconds; a test checks it against
 * ts-fsrs. Loss is the usual FSRS one: binary cross-entropy of the predicted recall probability at
 * each review that comes a day or more after the previous one (recalled = any rating but Again).
 * Gradients are central differences; steps are Adam's; weights stay inside ts-fsrs's own bounds.
 */
import { CLAMP_PARAMETERS, default_w, W17_W18_Ceiling } from "ts-fsrs";
import { dayStart } from "./day";

/** One card's reviews in order: days since the previous review (0 for the first) and the grade 1–4. */
export type ReviewSeq = Array<{ t: number; g: number }>;

const S_MIN = 1e-3;
const S_MAX = 36500;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function recall(w: readonly number[], t: number, s: number): number {
  const decay = -w[20];
  const factor = Math.pow(0.9, 1 / decay) - 1;
  return Math.pow(1 + (factor * t) / s, decay);
}

/** ts-fsrs `next_state` (short-term on), without rounding. `s === 0` means a new card. */
export function nextState(w: readonly number[], d: number, s: number, t: number, g: number): [number, number] {
  const initD = (gr: number) => w[4] - Math.exp((gr - 1) * w[5]) + 1;
  if (s === 0) return [clamp(initD(g), 1, 10), Math.max(w[g - 1], 0.1)];
  const r = recall(w, t, s);
  let ns: number;
  if (t === 0) {
    const sinc = Math.pow(s, -w[19]) * Math.exp(w[17] * (g - 3 + w[18]));
    ns = clamp(s * (g >= 2 ? Math.max(sinc, 1) : sinc), S_MIN, S_MAX);
  } else if (g === 1) {
    const forget = clamp(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), S_MIN, S_MAX);
    ns = clamp(s / Math.exp(w[17] * w[18]), S_MIN, forget);
  } else {
    const hard = g === 2 ? w[15] : 1;
    const easy = g === 4 ? w[16] : 1;
    ns = clamp(s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hard * easy), S_MIN, S_MAX);
  }
  const delta = -w[6] * (g - 3);
  const nd = d + (delta * (10 - d)) / 9;
  const reverted = w[7] * initD(4) + (1 - w[7]) * nd;
  return [clamp(reverted, 1, 10), ns];
}

/** Mean log loss and the number of predictions it was taken over. */
export function logLoss(w: readonly number[], seqs: readonly ReviewSeq[]): { loss: number; n: number } {
  let sum = 0;
  let n = 0;
  for (const seq of seqs) {
    let d = 0;
    let s = 0;
    for (let i = 0; i < seq.length; i++) {
      const { t, g } = seq[i];
      if (i > 0 && t > 0) {
        const p = clamp(recall(w, t, s), 1e-6, 1 - 1e-6);
        sum -= g > 1 ? Math.log(p) : Math.log(1 - p);
        n++;
      }
      [d, s] = nextState(w, d, s, t, g);
    }
  }
  return { loss: n ? sum / n : 0, n };
}

export interface OptimizeResult {
  weights: number[];
  lossBefore: number;
  lossAfter: number;
  /** Reviews the loss is measured on (a day or more after the previous review). */
  reviews: number;
}

export const MIN_REVIEWS_TO_OPTIMIZE = 400;

/**
 * Fit the weights. `progress` gets 0–1 and may return a promise (the caller yields to the UI there).
 * Starts from `start` (the preset's current weights, or ts-fsrs defaults).
 */
export async function optimize(
  seqs: readonly ReviewSeq[],
  start: readonly number[] = default_w,
  opts: { iterations?: number; progress?: (f: number) => void | Promise<void> } = {},
): Promise<OptimizeResult> {
  const bounds = CLAMP_PARAMETERS(W17_W18_Ceiling, true);
  const project = (w: number[]) => w.map((v, i) => clamp(v, bounds[i][0], bounds[i][1]));
  let w = project([...start]);
  const before = logLoss(w, seqs);
  const iters = opts.iterations ?? 120;
  const lr = 0.02;
  const [b1, b2, eps] = [0.9, 0.999, 1e-8];
  const m = new Array(w.length).fill(0);
  const v = new Array(w.length).fill(0);
  let best = { w, loss: before.loss };
  for (let it = 1; it <= iters; it++) {
    const grad = w.map((wi, i) => {
      const h = Math.max(1e-4, Math.abs(wi) * 1e-3);
      const up = [...w];
      const dn = [...w];
      up[i] = wi + h;
      dn[i] = wi - h;
      return (logLoss(up, seqs).loss - logLoss(dn, seqs).loss) / (2 * h);
    });
    w = project(
      w.map((wi, i) => {
        m[i] = b1 * m[i] + (1 - b1) * grad[i];
        v[i] = b2 * v[i] + (1 - b2) * grad[i] * grad[i];
        const mh = m[i] / (1 - Math.pow(b1, it));
        const vh = v[i] / (1 - Math.pow(b2, it));
        const range = bounds[i][1] - bounds[i][0];
        return wi - lr * Math.min(range, 1) * (mh / (Math.sqrt(vh) + eps));
      }),
    );
    const now = logLoss(w, seqs).loss;
    if (now < best.loss) best = { w, loss: now };
    if (opts.progress) await opts.progress(it / iters);
  }
  return { weights: best.w.map((x) => Math.round(x * 10000) / 10000), lossBefore: before.loss, lossAfter: best.loss, reviews: before.n };
}

/**
 * Review history → sequences: each card's answers in order, with whole days between them counted
 * from the study-day boundary (as Anki and FSRS count them).
 */
export function sequencesFrom(histories: Iterable<ReadonlyArray<{ ts: string; rating: string }>>, dayStartHour: number): ReviewSeq[] {
  const GRADE: Record<string, number> = { again: 1, hard: 2, good: 3, easy: 4 };
  // Local study days (DST-safe: round the gap between day starts).
  const day = (ts: string) => Math.round(dayStart(Date.parse(ts), dayStartHour) / 86400000);
  const out: ReviewSeq[] = [];
  for (const h of histories) {
    if (h.length < 2) continue;
    const seq: ReviewSeq = [];
    let prev: number | null = null;
    for (const r of h) {
      const g = GRADE[r.rating];
      if (!g) continue;
      const dd = day(r.ts);
      seq.push({ t: prev === null ? 0 : Math.max(0, dd - prev), g });
      prev = dd;
    }
    if (seq.some((x, i) => i > 0 && x.t > 0)) out.push(seq);
  }
  return out;
}
