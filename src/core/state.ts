/**
 * Derived card state (spec 0001 §4.3): the union of every device's log events, de-duplicated,
 * with undone events removed and aliases applied, replayed in time order through ts-fsrs.
 */
import { State, type Card, type FSRS } from "ts-fsrs";
import { nextDayStart } from "./day";
import type { LogEvent, RatingName } from "./log";
import { GRADE, newCard } from "./scheduler";

export interface ReviewEntry {
  ts: string;
  rating: RatingName;
  ms: number;
  device?: string;
  /** FSRS state before this answer (New, Learning, Review, Relearning). */
  stateBefore: State;
  /** Due date after this answer. */
  due: Date;
}

export interface CardState {
  key: string;
  card: Card;
  suspended: boolean;
  /** Epoch ms; the card is hidden until then (Anki's bury). */
  buriedUntil: number;
  flag: number;
  marked: boolean;
  reviews: ReviewEntry[];
  lastHash?: string;
}

export interface ReplayOptions {
  schedulerFor: (key: string) => FSRS;
  dayStartHour: number;
}

function eventId(e: LogEvent): string {
  return `${e.device ?? ""}|${e.ts}|${e.key}|${e.type}`;
}

function emptyState(key: string, at: Date): CardState {
  return { key, card: newCard(at), suspended: false, buriedUntil: 0, flag: 0, marked: false, reviews: [] };
}

function compareEvents(a: LogEvent, b: LogEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  const da = a.device ?? "";
  const db = b.device ?? "";
  return da < db ? -1 : da > db ? 1 : 0;
}

/**
 * Clean a raw event list: drop duplicates (e.g. iCloud's "2026-09 2.md" copies), drop undone
 * events, and rewrite aliased keys so an edited cloze keeps its history (spec 0002 §3.4).
 * The result is sorted by (timestamp, device) and contains no undo/alias events.
 */
export function normaliseEvents(raw: LogEvent[]): LogEvent[] {
  const seen = new Set<string>();
  const unique: LogEvent[] = [];
  for (const e of raw) {
    const id = eventId(e);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(e);
  }
  const undone = new Set<string>();
  const alias = new Map<string, string>();
  for (const e of unique) {
    if (e.type === "undo") undone.add(`${e.key}|${e.target}`);
    if (e.type === "alias" && e.from !== e.key) alias.set(e.from, e.key);
  }
  const resolve = (key: string): string => {
    let k = key;
    for (let hops = 0; alias.has(k) && hops < 32; hops++) k = alias.get(k)!;
    return k;
  };
  return unique
    .filter((e) => e.type !== "undo" && e.type !== "alias" && !undone.has(`${e.key}|${e.ts}`))
    .map((e) => (alias.has(e.key) ? { ...e, key: resolve(e.key) } : e))
    .sort(compareEvents);
}

/** Apply one (already normalised) event to a card's state. */
export function applyEvent(s: CardState, e: LogEvent, f: FSRS, dayStartHour: number): void {
  const at = new Date(e.ts);
  switch (e.type) {
    case "review": {
      const before = s.card.state;
      s.card = f.next(s.card, at, GRADE[e.rating]).card;
      s.reviews.push({ ts: e.ts, rating: e.rating, ms: e.ms, device: e.device, stateBefore: before, due: s.card.due });
      s.lastHash = e.hash;
      s.buriedUntil = 0;
      break;
    }
    case "reset":
      s.card = newCard(at);
      break;
    case "reschedule":
      s.card = { ...s.card, due: new Date(e.due) };
      break;
    case "import": {
      const last = new Date(e.lastReview);
      const due = new Date(e.due);
      s.card = {
        ...newCard(last),
        due,
        stability: e.stability,
        difficulty: e.difficulty,
        state: State.Review,
        reps: 1,
        last_review: last,
        scheduled_days: Math.max(1, Math.round((due.getTime() - last.getTime()) / 86400000)),
      };
      break;
    }
    case "suspend":
      s.suspended = true;
      break;
    case "unsuspend":
      s.suspended = false;
      break;
    case "bury":
      s.buriedUntil = nextDayStart(at.getTime(), dayStartHour);
      break;
    case "flag":
      s.flag = e.flag;
      break;
    case "mark":
      s.marked = e.marked;
      break;
  }
}

export function replay(raw: LogEvent[], opts: ReplayOptions): Map<string, CardState> {
  const states = new Map<string, CardState>();
  for (const e of normaliseEvents(raw)) {
    let s = states.get(e.key);
    if (!s) {
      s = emptyState(e.key, new Date(e.ts));
      states.set(e.key, s);
    }
    applyEvent(s, e, opts.schedulerFor(e.key), opts.dayStartHour);
  }
  return states;
}

/**
 * Holds every known event and the derived states. Local answers are applied incrementally;
 * anything that can reorder history (another device's file, an undo) rebuilds.
 */
export class ReviewState {
  private events: LogEvent[] = [];
  private ids = new Set<string>();
  private latest?: LogEvent;
  states = new Map<string, CardState>();

  constructor(private opts: ReplayOptions) {}

  setOptions(opts: ReplayOptions): void {
    this.opts = opts;
    this.rebuild();
  }

  /** Replace all events (e.g. after reading every log file) and rebuild. */
  load(events: LogEvent[]): void {
    this.events = [];
    this.ids.clear();
    for (const e of events) {
      const id = eventId(e);
      if (this.ids.has(id)) continue;
      this.ids.add(id);
      this.events.push(e);
    }
    this.rebuild();
  }

  rebuild(): void {
    this.states = replay(this.events, this.opts);
    this.latest = undefined;
    for (const e of this.events) {
      if (!this.latest || compareEvents(this.latest, e) < 0) this.latest = e;
    }
  }

  allEvents(): readonly LogEvent[] {
    return this.events;
  }

  /** Add an event this device just wrote. */
  add(e: LogEvent): void {
    const id = eventId(e);
    if (this.ids.has(id)) return; // already known (e.g. a reload read it from disk first)
    this.ids.add(id);
    this.events.push(e);
    const inOrder = !this.latest || compareEvents(this.latest, e) <= 0;
    if (e.type === "undo" || e.type === "alias" || !inOrder) {
      this.rebuild();
      return;
    }
    this.latest = e;
    let s = this.states.get(e.key);
    if (!s) {
      s = emptyState(e.key, new Date(e.ts));
      this.states.set(e.key, s);
    }
    applyEvent(s, e, this.opts.schedulerFor(e.key), this.opts.dayStartHour);
  }

  get(key: string): CardState | undefined {
    return this.states.get(key);
  }
}
