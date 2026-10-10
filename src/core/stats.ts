/**
 * Statistics (spec 0007): the numbers behind Anki's Stats screen and the Review Heatmap
 * add-on. Pure functions over derived card states, so they run the same on the Mac and the
 * iPhone and can be unit-tested.
 */
import { State } from "ts-fsrs";
import type { RatingName } from "./log";
import type { QueueItem } from "./queue";
import type { CardState } from "./state";

export const DAY_MS = 86400000;
/** Anki calls a review card "mature" once its interval reaches 21 days. */
export const MATURE_DAYS = 21;

/**
 * A study day as a whole number (days since 1970-01-01 of the local calendar date), where the
 * day starts at `startHour` like Anki's. Whole numbers make streaks and grids simple.
 */
export function studyDay(ms: number, startHour: number): number {
  const d = new Date(ms - startHour * 3600000);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** The calendar date of a study day, as a UTC Date (read it with getUTC*). */
export function dayDate(day: number): Date {
  return new Date(day * DAY_MS);
}

export type ReviewKind = "learn" | "young" | "mature" | "relearn";

export interface ReviewRow {
  key: string;
  ts: number;
  day: number;
  /** Local hour of day, 0–23. */
  hour: number;
  ms: number;
  rating: RatingName;
  kind: ReviewKind;
}

/** Every answer in the history, classified the way Anki's graphs do. */
export function reviewRows(states: Iterable<CardState>, startHour: number): ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const s of states) {
    let prev: { ts: number; due: number } | undefined;
    for (const r of s.reviews) {
      const ts = Date.parse(r.ts);
      let kind: ReviewKind;
      if (r.stateBefore === State.New || r.stateBefore === State.Learning) kind = "learn";
      else if (r.stateBefore === State.Relearning) kind = "relearn";
      else {
        // The interval the card had when it was answered: the gap its last answer scheduled.
        const ivl = prev ? (prev.due - prev.ts) / DAY_MS : 0;
        kind = ivl >= MATURE_DAYS ? "mature" : "young";
      }
      rows.push({ key: s.key, ts, day: studyDay(ts, startHour), hour: new Date(ts).getHours(), ms: r.ms, rating: r.rating, kind });
      prev = { ts, due: r.due.getTime() };
    }
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

/** Answers per study day. */
export function activityByDay(rows: ReviewRow[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.day, (m.get(r.day) ?? 0) + 1);
  return m;
}

// ---------------------------------------------------------------------------------------------
// Review Heatmap add-on

export interface StreakStats {
  /** Average answers on days with any activity. */
  dailyAvg: number;
  /** Days with activity as a % of the days since the first review. */
  pctDaysLearned: number;
  longestStreak: number;
  /** Counts if the last study day was today or yesterday (so it doesn't reset before you study). */
  currentStreak: number;
}

export function streakStats(activity: Map<number, number>, today: number): StreakStats {
  const days = [...activity.keys()].filter((d) => d <= today).sort((a, b) => a - b);
  if (!days.length) return { dailyAvg: 0, pctDaysLearned: 0, longestStreak: 0, currentStreak: 0 };
  let longest = 0;
  let run = 0;
  let total = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i - 1] + 1 === days[i] ? run + 1 : 1;
    longest = Math.max(longest, run);
    total += activity.get(days[i])!;
  }
  const last = days[days.length - 1];
  const span = today - days[0] + 1;
  return {
    dailyAvg: Math.round(total / days.length),
    pctDaysLearned: span <= 1 ? 100 : Math.round((days.length / span) * 100),
    longestStreak: longest,
    currentStreak: last >= today - 1 ? run : 0,
  };
}

/** Colour steps relative to the daily average (never below 20), as in the add-on. */
export function heatmapThresholds(dailyAvg: number): number[] {
  const avg = Math.max(20, dailyAvg);
  return [0.125, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4].map((f) => f * avg);
}

/** Colour level 0 (none) to 10 (hottest) for a day's count. */
export function heatLevel(count: number, thresholds: number[]): number {
  if (count <= 0) return 0;
  for (let i = 0; i < thresholds.length; i++) if (count <= thresholds[i]) return i + 1;
  return 10;
}

/** Colour levels for the stats under the heatmap, on the add-on's fixed scales. */
export function streakLevel(days: number): number {
  const steps: [number, number][] = [[0, 0], [14, 2], [30, 4], [90, 6], [180, 9]];
  for (const [max, level] of steps) if (days <= max) return level;
  return 10;
}

export function percentLevel(pct: number): number {
  const steps = [0, 25, 50, 60, 70, 80, 85, 90, 95, 99];
  for (let i = 0; i < steps.length; i++) if (pct <= steps[i]) return i;
  return 10;
}

// ---------------------------------------------------------------------------------------------
// Future due / forecast

/** Cards due per future study day. Overdue cards count on today (Anki's backlog). */
export function forecast(items: QueueItem[], today: number, startHour: number, includeBacklog = true): Map<number, number> {
  const m = new Map<number, number>();
  for (const { state } of items) {
    if (!state || state.suspended || state.card.state === State.New) continue;
    let day = studyDay(state.card.due.getTime(), startHour);
    if (day < today) {
      if (!includeBacklog) continue;
      day = today;
    }
    m.set(day, (m.get(day) ?? 0) + 1);
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// Today

export interface TodaySummary {
  cards: number;
  ms: number;
  again: number;
  learn: number;
  review: number;
  relearn: number;
  matureCorrect: number;
  matureTotal: number;
}

export function todaySummary(rows: ReviewRow[], today: number): TodaySummary {
  const t: TodaySummary = { cards: 0, ms: 0, again: 0, learn: 0, review: 0, relearn: 0, matureCorrect: 0, matureTotal: 0 };
  for (const r of rows) {
    if (r.day !== today) continue;
    t.cards++;
    t.ms += r.ms;
    if (r.rating === "again") t.again++;
    if (r.kind === "learn") t.learn++;
    else if (r.kind === "relearn") t.relearn++;
    else t.review++;
    if (r.kind === "mature") {
      t.matureTotal++;
      if (r.rating !== "again") t.matureCorrect++;
    }
  }
  return t;
}

// ---------------------------------------------------------------------------------------------
// Reviews graph

export interface DayReviews {
  day: number;
  count: Record<ReviewKind, number>;
  ms: Record<ReviewKind, number>;
}

const zeroKinds = (): Record<ReviewKind, number> => ({ learn: 0, young: 0, mature: 0, relearn: 0 });

/** One entry per day in [from, to], including days with no reviews. */
export function reviewsByDay(rows: ReviewRow[], from: number, to: number): DayReviews[] {
  const out: DayReviews[] = [];
  for (let d = from; d <= to; d++) out.push({ day: d, count: zeroKinds(), ms: zeroKinds() });
  for (const r of rows) {
    if (r.day < from || r.day > to) continue;
    const e = out[r.day - from];
    e.count[r.kind]++;
    e.ms[r.kind] += r.ms;
  }
  return out;
}

export interface PeriodSummary {
  daysStudied: number;
  daysTotal: number;
  total: number;
  avgStudied: number;
  avgOverall: number;
}

export function periodSummary(values: number[]): PeriodSummary {
  const studied = values.filter((v) => v > 0).length;
  const total = values.reduce((a, b) => a + b, 0);
  return {
    daysStudied: studied,
    daysTotal: values.length,
    total,
    avgStudied: studied ? total / studied : 0,
    avgOverall: values.length ? total / values.length : 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Card counts

export interface CardCounts {
  new: number;
  learning: number;
  relearning: number;
  young: number;
  mature: number;
  suspended: number;
  buried: number;
}

export function cardCounts(items: QueueItem[], nowMs: number): CardCounts {
  const c: CardCounts = { new: 0, learning: 0, relearning: 0, young: 0, mature: 0, suspended: 0, buried: 0 };
  for (const { state } of items) {
    if (state?.suspended) c.suspended++;
    else if (state && state.buriedUntil > nowMs) c.buried++;
    else {
      const s = state?.card.state ?? State.New;
      if (s === State.New) c.new++;
      else if (s === State.Learning) c.learning++;
      else if (s === State.Relearning) c.relearning++;
      else if (state!.card.scheduled_days >= MATURE_DAYS) c.mature++;
      else c.young++;
    }
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// Histograms and breakdowns

export interface Bin {
  from: number;
  to: number;
  count: number;
}

/** Equal-width bins over [min, max]; values outside are clamped into the end bins. */
export function histogram(values: number[], min: number, max: number, bins: number): Bin[] {
  const width = (max - min) / bins;
  const out: Bin[] = Array.from({ length: bins }, (_, i) => ({ from: min + i * width, to: min + (i + 1) * width, count: 0 }));
  for (const v of values) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((v - min) / width)));
    out[i].count++;
  }
  return out;
}

/** The value below which `p` (0–1) of the values fall. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Cards that have left learning: their current intervals, stabilities and difficulties. */
export function reviewCards(items: QueueItem[]): CardState[] {
  const out: CardState[] = [];
  for (const { state } of items) {
    if (!state || state.suspended) continue;
    if (state.card.state === State.Review || state.card.state === State.Relearning) out.push(state);
  }
  return out;
}

/** FSRS difficulty (1–10) as Anki shows it, 0–100 %. */
export function difficultyPct(d: number): number {
  return Math.min(100, Math.max(0, ((d - 1) / 9) * 100));
}

export interface HourStat {
  hour: number;
  total: number;
  correct: number;
}

export function hourly(rows: ReviewRow[], fromDay: number): HourStat[] {
  const out: HourStat[] = Array.from({ length: 24 }, (_, hour) => ({ hour, total: 0, correct: 0 }));
  for (const r of rows) {
    if (r.day < fromDay) continue;
    out[r.hour].total++;
    if (r.rating !== "again") out[r.hour].correct++;
  }
  return out;
}

export type ButtonGroup = "learning" | "young" | "mature";

/** Presses of Again / Hard / Good / Easy, split like Anki's Answer Buttons graph. */
export function answerButtons(rows: ReviewRow[], fromDay: number): Record<ButtonGroup, [number, number, number, number]> {
  const out: Record<ButtonGroup, [number, number, number, number]> = { learning: [0, 0, 0, 0], young: [0, 0, 0, 0], mature: [0, 0, 0, 0] };
  const idx: Record<RatingName, number> = { again: 0, hard: 1, good: 2, easy: 3 };
  for (const r of rows) {
    if (r.day < fromDay) continue;
    const g: ButtonGroup = r.kind === "learn" || r.kind === "relearn" ? "learning" : r.kind;
    out[g][idx[r.rating]]++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// True retention (Anki 24.11+): pass rate of review-card answers over fixed periods

export interface RetentionRow {
  label: string;
  young: { pass: number; fail: number };
  mature: { pass: number; fail: number };
}

export function trueRetention(rows: ReviewRow[], today: number): RetentionRow[] {
  const periods: [string, number, number][] = [
    ["Today", today, today],
    ["Yesterday", today - 1, today - 1],
    ["Last week", today - 6, today],
    ["Last month", today - 29, today],
    ["Last year", today - 364, today],
    ["All time", -Infinity, today],
  ];
  return periods.map(([label, from, to]) => {
    const row: RetentionRow = { label, young: { pass: 0, fail: 0 }, mature: { pass: 0, fail: 0 } };
    for (const r of rows) {
      if (r.day < from || r.day > to || (r.kind !== "young" && r.kind !== "mature")) continue;
      const b = row[r.kind];
      if (r.rating === "again") b.fail++;
      else b.pass++;
    }
    return row;
  });
}

// ---------------------------------------------------------------------------------------------
// More Decks Stats and Time Left add-on

/** Cards per minute over recent answers (default: the last 30 days). */
export function cardsPerMinute(rows: ReviewRow[], today: number, days = 30): number {
  let n = 0;
  let ms = 0;
  for (const r of rows) {
    if (r.day <= today - days) continue;
    n++;
    ms += r.ms;
  }
  return ms > 0 ? n / (ms / 60000) : 0;
}
