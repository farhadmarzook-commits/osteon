import { describe, expect, it } from "vitest";
import { default_w, FSRSAlgorithm, generatorParameters } from "ts-fsrs";
import { logLoss, nextState, optimize, recall, sequencesFrom, type ReviewSeq } from "../src/core/optimizer";

// Deterministic pseudo-random numbers for repeatable tests.
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

describe("FSRS optimizer (spec 0013)", () => {
  it("the inline memory model matches ts-fsrs next_state and forgetting_curve", () => {
    const algo = new FSRSAlgorithm(generatorParameters({ enable_short_term: true }));
    const rand = rng(7);
    for (let k = 0; k < 500; k++) {
      const d = 1 + rand() * 9;
      const s = 0.1 + rand() * 300;
      const t = rand() < 0.2 ? 0 : Math.floor(rand() * 400);
      const g = 1 + Math.floor(rand() * 4);
      const ref = algo.next_state({ difficulty: d, stability: s }, t, g);
      const [nd, ns] = nextState(default_w, d, s, t, g);
      expect(nd).toBeCloseTo(ref.difficulty, 4);
      expect(ns / ref.stability).toBeCloseTo(1, 4);
      if (t > 0) expect(recall(default_w, t, s)).toBeCloseTo(algo.forgetting_curve(t, s), 6);
    }
    const first = algo.next_state(null, 0, 3);
    const [d0, s0] = nextState(default_w, 0, 0, 0, 3);
    expect(d0).toBeCloseTo(first.difficulty, 6);
    expect(s0).toBeCloseTo(first.stability, 6);
  });

  it("fits simulated history better than a mis-set starting point", async () => {
    // Simulate learners whose memory follows default_w; start the fit from a distorted copy.
    const rand = rng(11);
    const seqs: ReviewSeq[] = [];
    for (let c = 0; c < 300; c++) {
      const seq: ReviewSeq = [];
      let d = 0;
      let s = 0;
      let t = 0;
      for (let i = 0; i < 8; i++) {
        let g: number;
        if (i === 0) g = 3;
        else g = rand() < recall(default_w, t, s) ? (rand() < 0.15 ? 4 : 3) : 1;
        seq.push({ t, g });
        [d, s] = nextState(default_w, d, s, t, g);
        t = Math.max(1, Math.round(s * (0.5 + rand())));
      }
      seqs.push(seq);
    }
    const start = default_w.map((x, i) => (i < 4 ? x * 3 : i === 20 ? x : x * 1.3));
    const res = await optimize(seqs, start, { iterations: 60 });
    expect(res.reviews).toBeGreaterThan(1500);
    expect(res.lossAfter).toBeLessThan(res.lossBefore);
    expect(res.lossAfter - logLoss(default_w, seqs).loss).toBeLessThan(0.02); // close to the true model
    expect(res.weights).toHaveLength(21);
  }, 60000);

  it("turns review history into day-gap sequences, skipping cards with no spaced review", () => {
    const seqs = sequencesFrom(
      [
        [
          { ts: "2026-09-01T10:00:00Z", rating: "good" },
          { ts: "2026-09-01T10:10:00Z", rating: "good" },
          { ts: "2026-09-04T10:00:00Z", rating: "again" },
        ],
        [{ ts: "2026-09-01T10:00:00Z", rating: "good" }, { ts: "2026-09-01T11:00:00Z", rating: "hard" }],
      ],
      4,
    );
    expect(seqs).toEqual([[{ t: 0, g: 3 }, { t: 0, g: 3 }, { t: 3, g: 1 }]]);
  });
});
