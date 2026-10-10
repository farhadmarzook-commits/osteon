/**
 * Migration from obsidian-spaced-repetition (spec 0002 §8). Pure: note text in, new text plus
 * `import` events and a report out.
 *
 * - `?` / `??` multi-line cards with a one-line front become `front ::` / `front :::`.
 * - Each card's `<!--SR:...-->` schedule becomes an `import` event per sibling, the comment is
 *   removed, and the card gets its `^fc-` ID.
 * - Cards that break the short-card rule are listed for rewriting.
 */
import { dayStart } from "./day";
import type { LogEvent } from "./log";
import { parseNote, type ParsedCard } from "./parser";

export interface MigrationIssue {
  line: number;
  text: string;
  reason: string;
}

export interface MigrationResult {
  text: string;
  events: LogEvent[];
  cards: number;
  scheduled: number;
  converted: number;
  manual: MigrationIssue[];
  rewrite: MigrationIssue[];
}

interface SrSchedule {
  due: Date;
  intervalDays: number;
  ease?: number;
  stability?: number;
  difficulty?: number;
  lastReview?: Date;
}

const SR_COMMENT = /<!--SR:(.*?)-->/;
const SR_COMMENT_G = /\s*<!--SR:.*?-->/g;

function isPureSrLine(line: string | undefined): boolean {
  return !!line && /^\s*<!--SR:.*-->\s*$/.test(line);
}

/** Parse the segments of an SR comment: `!2026-10-01,12,250` or `!fsrs,<iso due>,ivl,s,d,...`. */
export function parseSrComment(body: string, dayStartHour: number): SrSchedule[] {
  const out: SrSchedule[] = [];
  for (const seg of body.split("!").map((x) => x.trim()).filter(Boolean)) {
    const f = seg.split(",");
    if (f[0] === "fsrs") {
      const due = new Date(f[1]);
      const intervalDays = Number(f[2]);
      const stability = Number(f[3]);
      const difficulty = Number(f[4]);
      const last = f[9] && f[9] !== "-" ? new Date(f[9]) : undefined;
      if (Number.isNaN(due.getTime()) || !(stability > 0)) continue;
      out.push({ due, intervalDays, stability, difficulty, lastReview: last });
      continue;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f[0]);
    const intervalDays = Number(f[1]);
    const ease = Number(f[2]);
    if (!m || !(intervalDays >= 0) || !(ease > 0)) continue;
    const local = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
    const due = new Date(dayStart(local.getTime(), dayStartHour));
    out.push({ due, intervalDays, ease });
  }
  return out;
}

/** SM-2 interval/ease → an FSRS starting state (0001 §6): stability ≈ interval, ease → difficulty. */
export function srToFsrs(s: SrSchedule): { stability: number; difficulty: number; lastReview: Date } {
  const stability = s.stability ?? Math.max(0.5, s.intervalDays);
  const ease = s.ease ?? 250;
  const difficulty = s.difficulty ?? Math.min(10, Math.max(1, 10 - (ease - 130) / 22));
  const lastReview = s.lastReview ?? new Date(s.due.getTime() - Math.max(1, s.intervalDays) * 86400000);
  return { stability, difficulty: Math.round(difficulty * 100) / 100, lastReview };
}

/** `?` / `??` cards with a one-line front become `front ::` / `front :::` (their back unchanged). */
function convertMultiline(lines: string[], manual: MigrationIssue[]): number {
  let converted = 0;
  for (let i = lines.length - 1; i >= 1; i--) {
    const t = lines[i].trim();
    if (t !== "?" && t !== "??") continue;
    let start = i - 1;
    while (start > 0 && lines[start - 1].trim() !== "") start--;
    if (lines[start].trim() === "") continue;
    if (start !== i - 1) {
      manual.push({ line: start + 1, text: lines[start], reason: "Multi-line front (SR `?` card): write it as one line, then `::`" });
      continue;
    }
    lines[i - 1] = `${lines[i - 1].trimEnd()} ${t === "?" ? "::" : ":::"}`;
    lines.splice(i, 1);
    converted++;
  }
  return converted;
}

function wordCount(s: string): number {
  return s.replace(/[=*{}:]/g, " ").split(/\s+/).filter(Boolean).length;
}

/** Why a card breaks the short-card rule (spec 0002 §7), or null. */
export function shapeIssues(card: ParsedCard): string | null {
  if (card.type === "cloze") {
    const long = card.clozes.find((c) => wordCount(c.answer) > 6 || c.answer.length > 40);
    if (long) return "Explanation inside the cloze: move it to a line under the card";
  }
  if (wordCount(card.front) > 20) return "Front is longer than 20 words";
  return null;
}

export function migrateNote(
  text: string,
  opts: { now: Date; dayStartHour: number; newId: () => string },
): MigrationResult {
  const manual: MigrationIssue[] = [];
  const rewrite: MigrationIssue[] = [];
  const events: LogEvent[] = [];
  const lines = text.split("\n");
  const converted = convertMultiline(lines, manual);
  const cards = parseNote(lines.join("\n"));
  const ts = opts.now.toISOString();
  let scheduled = 0;

  // Cards on consecutive lines were one card in SR (a multi-line paragraph); their SR comment
  // can't be split reliably, so they're left for a manual look.
  const merged = new Set<number>();
  for (let k = 1; k < cards.length; k++) {
    if (cards[k].startLine === cards[k - 1].endLine + 1) {
      merged.add(k - 1);
      merged.add(k);
    }
  }

  for (let k = cards.length - 1; k >= 0; k--) {
    const card = cards[k];
    const issue = shapeIssues(card);
    if (issue) rewrite.unshift({ line: card.startLine + 1, text: lines[card.startLine], reason: issue });

    const blockSr = card.sourceLines.map((l) => SR_COMMENT.exec(l)?.[1]).find((x) => x !== undefined);
    const afterIdx = card.endLine + 1;
    const afterSr = isPureSrLine(lines[afterIdx]) ? SR_COMMENT.exec(lines[afterIdx])![1] : undefined;
    const srBody = blockSr ?? afterSr;
    // …except a one-line question card that carries its own comment: SR reads each such line as a
    // card of its own (a list of `Question::Answer` lines), so its schedule is unambiguous.
    const ownLine = card.sourceLines.length === 1 && blockSr !== undefined && card.type !== "cloze";
    if (srBody !== undefined && merged.has(k) && !ownLine) {
      manual.push({ line: card.startLine + 1, text: lines[card.startLine], reason: "SR card spanning several lines: its schedule wasn't imported" });
      continue;
    }
    if (srBody === undefined) continue;

    const id = card.id ?? opts.newId();
    const schedules = parseSrComment(srBody, opts.dayStartHour);
    card.slots.forEach((slot, i) => {
      const sch = schedules[i];
      if (!sch) return;
      const f = srToFsrs(sch);
      events.push({
        ts,
        type: "import",
        key: `${id}.${slot}`,
        due: sch.due.toISOString(),
        stability: f.stability,
        difficulty: f.difficulty,
        lastReview: f.lastReview.toISOString(),
      });
      scheduled++;
    });

    // Edit the text: drop the SR comment (inline, own line inside the block, or the next line),
    // then add the ID. Working bottom-up keeps earlier line numbers valid.
    if (afterSr !== undefined && blockSr === undefined) lines.splice(afterIdx, 1);
    let idLine = card.idLine;
    for (let i = card.endLine; i >= card.startLine; i--) {
      if (isPureSrLine(lines[i])) {
        lines.splice(i, 1);
        if (i < idLine) idLine--;
      } else {
        lines[i] = lines[i].replace(SR_COMMENT_G, "");
      }
    }
    if (!card.id) lines[idLine] = `${lines[idLine].trimEnd()} ^fc-${id}`;
  }

  return { text: lines.join("\n"), events, cards: cards.length, scheduled, converted, manual, rewrite };
}
