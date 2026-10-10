/**
 * Review log format (spec 0001 §4.2). One event per line, tab-separated:
 *   <ISO UTC timestamp> <type> <card key> <type-specific fields...>
 * Each device appends only to its own files, so no file is ever written by two devices.
 */

export const RATINGS = ["again", "hard", "good", "easy"] as const;
export type RatingName = (typeof RATINGS)[number];

interface Base {
  ts: string;
  key: string;
  /** Filled in from the folder the file came from; not stored in the line. */
  device?: string;
}

export type LogEvent =
  | (Base & { type: "review"; rating: RatingName; ms: number; hash: string })
  | (Base & { type: "suspend" | "unsuspend" | "bury" | "reset" })
  | (Base & { type: "reschedule"; due: string })
  | (Base & {
      type: "import";
      due: string;
      stability: number;
      difficulty: number;
      lastReview: string;
    })
  | (Base & { type: "undo"; target: string })
  | (Base & { type: "flag"; flag: number })
  | (Base & { type: "mark"; marked: boolean })
  | (Base & { type: "alias"; from: string });

export const LOG_VERSION = 1;

export function logHeader(device: string): string {
  return `# fc-review-log v${LOG_VERSION} · device ${device} · do not edit by hand`;
}

/**
 * A comment line written once per session, before that session's first event, so another device
 * can tell which plugin version wrote the answers. Comments are skipped by every version's parser.
 */
export function sessionLine(ts: string, version: string): string {
  return `# session ${ts} · Osteon ${version}`;
}

const SESSION = /^# session (\S+) · Osteon (\S+)/;

export function formatEvent(e: LogEvent): string {
  const head = [e.ts, e.type, e.key];
  switch (e.type) {
    case "review":
      return [...head, e.rating, String(Math.round(e.ms)), `h:${e.hash}`].join("\t");
    case "reschedule":
      return [...head, e.due].join("\t");
    case "import":
      return [...head, e.due, String(e.stability), String(e.difficulty), e.lastReview].join("\t");
    case "undo":
      return [...head, e.target].join("\t");
    case "flag":
      return [...head, String(e.flag)].join("\t");
    case "mark":
      return [...head, e.marked ? "1" : "0"].join("\t");
    case "alias":
      return [...head, e.from].join("\t");
    default:
      return head.join("\t");
  }
}

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const KEY = /^[a-z0-9]{8}\.[a-z0-9]+$/;

function isTs(s: string | undefined): s is string {
  return !!s && TS.test(s);
}

/** Parse one line. Returns null for anything malformed (spec 0001 §4.2: skip, never fix). */
export function parseEvent(line: string): LogEvent | null {
  const f = line.replace(/\r$/, "").split("\t");
  const [ts, type, key] = f;
  if (!isTs(ts) || !key || !KEY.test(key)) return null;
  switch (type) {
    case "review": {
      const rating = f[3] as RatingName;
      const ms = Number(f[4]);
      if (!RATINGS.includes(rating) || !Number.isFinite(ms)) return null;
      const hash = (f[5] ?? "").replace(/^h:/, "");
      return { ts, type, key, rating, ms, hash };
    }
    case "suspend":
    case "unsuspend":
    case "bury":
    case "reset":
      return { ts, type, key };
    case "reschedule":
      return isTs(f[3]) ? { ts, type, key, due: f[3] } : null;
    case "import": {
      const stability = Number(f[4]);
      const difficulty = Number(f[5]);
      if (!isTs(f[3]) || !isTs(f[6]) || !(stability > 0) || !Number.isFinite(difficulty)) return null;
      return { ts, type, key, due: f[3], stability, difficulty, lastReview: f[6] };
    }
    case "undo":
      return isTs(f[3]) ? { ts, type, key, target: f[3] } : null;
    case "flag": {
      const flag = Number(f[3]);
      return Number.isInteger(flag) && flag >= 0 && flag <= 7 ? { ts, type, key, flag } : null;
    }
    case "mark":
      return f[3] === "0" || f[3] === "1" ? { ts, type, key, marked: f[3] === "1" } : null;
    case "alias":
      return f[3] && KEY.test(f[3]) ? { ts, type, key, from: f[3] } : null;
    default:
      return null;
  }
}

export interface ParsedLog {
  events: LogEvent[];
  /** 1-based line numbers of lines that didn't parse (reported, never rewritten). */
  badLines: number[];
  /** Timestamp of the newest event in the file. */
  last?: string;
  /** The newest session line: when it was written and by which plugin version. */
  session?: { ts: string; version: string };
}

export function parseLog(text: string, device: string): ParsedLog {
  const events: LogEvent[] = [];
  const badLines: number[] = [];
  let last: string | undefined;
  let session: ParsedLog["session"];
  text.split("\n").forEach((line, i) => {
    if (line.startsWith("#")) {
      const m = SESSION.exec(line);
      if (m && isTs(m[1]) && (!session || m[1] >= session.ts)) session = { ts: m[1], version: m[2] };
      return;
    }
    if (line.trim() === "") return;
    const e = parseEvent(line);
    if (e) {
      events.push({ ...e, device });
      if (!last || e.ts > last) last = e.ts;
    } else badLines.push(i + 1);
  });
  return { events, badLines, last, session };
}

/** The log file an event belongs in: one per device per UTC month. */
export function logFileName(ts: string): string {
  return `${ts.slice(0, 7)}.md`;
}
