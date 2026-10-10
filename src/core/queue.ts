/** Today's study queue, following Anki's v3 scheduler (spec 0003 §5). */
import { State } from "ts-fsrs";
import type { CardRef } from "./collection";
import { dayStart, nextDayStart } from "./day";
import { shortHash } from "./hash";
import type { CardState } from "./state";
import type { DisplayOptions, NewReviewMix } from "./presets";

export interface QueueOptions {
  newPerDay: number;
  reviewsPerDay: number;
  dayStartHour: number;
  learnAheadMins: number;
  /** Display order and burying (Anki's deck options); defaults keep the old behaviour. */
  display?: DisplayOptions;
  bury?: { newSiblings: boolean; reviewSiblings: boolean; learningSiblings: boolean };
  /** A card answered Again this many times today rests until tomorrow (0 or missing = off). */
  missCap?: number;
  /** Adaptive new cards: no new cards while more than this many cards are still in learning today (0 or missing = off). */
  newPauseAbove?: number;
}

export const DEFAULT_QUEUE: QueueOptions = {
  newPerDay: 20,
  reviewsPerDay: 200,
  dayStartHour: 4,
  learnAheadMins: 20,
};

export interface DeckLimits {
  newPerDay: number;
  reviewsPerDay: number;
}

export interface QueueItem {
  ref: CardRef;
  state?: CardState;
}

export interface Queue {
  learning: QueueItem[];
  review: QueueItem[];
  fresh: QueueItem[];
  /** Earliest time a learning card later today becomes due, if any. */
  nextLearningDue?: Date;
  /** How new cards mix with reviews (Anki's "New/review order"). */
  mix?: NewReviewMix;
  /** Cards resting until tomorrow after too many misses today (`missCap`). */
  rested?: number;
  /** Cards answered today that are still in learning (what adaptive new cards looks at). */
  pile?: number;
  /** New cards held back right now by adaptive new cards. */
  newHeld?: number;
}

export interface TodayStats {
  newStudied: number;
  reviewsDone: number;
  answers: number;
  timeMs: number;
}

/** What's been studied today, from the log (counts all devices). */
export function todayStats(items: QueueItem[], nowMs: number, dayStartHour: number): TodayStats {
  const start = dayStart(nowMs, dayStartHour);
  const stats: TodayStats = { newStudied: 0, reviewsDone: 0, answers: 0, timeMs: 0 };
  for (const { state } of items) {
    if (!state) continue;
    // Reviews are in time order: walk back from the newest and stop at the first before today.
    for (let k = state.reviews.length - 1; k >= 0; k--) {
      const r = state.reviews[k];
      if (Date.parse(r.ts) < start) break;
      stats.answers++;
      stats.timeMs += r.ms;
      if (r.stateBefore === State.New) stats.newStudied++;
      else if (r.stateBefore === State.Review) stats.reviewsDone++;
    }
  }
  return stats;
}

/** How many times a card was answered Again since `sinceMs` (reviews are in time order). */
export function missesSince(s: CardState, sinceMs: number): number {
  let n = 0;
  for (let k = s.reviews.length - 1; k >= 0; k--) {
    const r = s.reviews[k];
    if (Date.parse(r.ts) < sinceMs) break;
    if (r.rating === "again") n++;
  }
  return n;
}

function isIntraday(s: CardState): boolean {
  const last = s.card.last_review?.getTime();
  if (last === undefined) return true;
  return s.card.due.getTime() - last < 86400000;
}

/**
 * Build today's queue. `o` holds the selected deck's limits; `limitsFor`, if given, adds each
 * card's own deck limits on top (Anki v3: a sub-deck's limits still apply when studying its
 * parent).
 */
export function buildQueue(
  items: QueueItem[],
  now: Date,
  o: QueueOptions,
  limitsFor?: (deck: string) => DeckLimits,
): Queue {
  const nowMs = now.getTime();
  const dayEnd = nextDayStart(nowMs, o.dayStartHour);
  const aheadMs = nowMs + o.learnAheadMins * 60000;
  const learning: QueueItem[] = [];
  const review: QueueItem[] = [];
  const fresh: QueueItem[] = [];
  let nextLearningDue: number | undefined;
  let rested = 0;
  let pile = 0;

  // Burying siblings (Anki): a card's other slots (cloze c2, the reverse) wait until tomorrow
  // once one of them has been answered today.
  const todayStart = dayStart(nowMs, o.dayStartHour);
  const answeredToday = new Set<string>();
  const noteOf = (i: QueueItem) => i.ref.card.id ?? `${i.ref.path}:${i.ref.card.startLine}`;
  if (o.bury && (o.bury.newSiblings || o.bury.reviewSiblings || o.bury.learningSiblings)) {
    for (const i of items) {
      const last = i.state?.reviews[i.state.reviews.length - 1];
      if (last && Date.parse(last.ts) >= todayStart) answeredToday.add(`${noteOf(i)}|${i.ref.slot}`);
    }
  }
  const siblingAnswered = (i: QueueItem) => {
    if (!answeredToday.size) return false;
    const n = noteOf(i);
    return i.ref.card.slots.some((sl) => sl !== i.ref.slot && answeredToday.has(`${n}|${sl}`)) && !answeredToday.has(`${n}|${i.ref.slot}`);
  };

  for (const item of items) {
    const s = item.state;
    if (s && (s.suspended || s.buriedUntil > nowMs)) continue;
    if (o.bury && siblingAnswered(item)) {
      const isNew = !s || s.card.state === State.New;
      const isLearn = !!s && (s.card.state === State.Learning || s.card.state === State.Relearning) && !isIntraday(s);
      if ((isNew && o.bury.newSiblings) || (isLearn && o.bury.learningSiblings) || (!isNew && !isLearn && s.card.state === State.Review && o.bury.reviewSiblings)) continue;
    }
    if (!s || s.card.state === State.New) {
      fresh.push(item);
      continue;
    }
    const due = s.card.due.getTime();
    const inLearning = s.card.state === State.Learning || s.card.state === State.Relearning;
    if (inLearning && isIntraday(s)) {
      // Missed too often today: another repeat teaches little, so it waits for tomorrow.
      if (o.missCap && due < dayEnd && missesSince(s, todayStart) >= o.missCap) {
        rested++;
        continue;
      }
      // The pile is today's work only: a card left in learning from an earlier day (an import, a
      // deck that's parked) shouldn't keep new cards paused.
      if (due < dayEnd && (s.card.last_review?.getTime() ?? 0) >= todayStart) pile++;
      if (due <= aheadMs) learning.push(item);
      else if (due < dayEnd) nextLearningDue = Math.min(nextLearningDue ?? Infinity, due);
      continue;
    }
    if (due < dayEnd) review.push(item);
  }

  const stats = todayStats(items, nowMs, o.dayStartHour);
  const dayKey = String(dayStart(nowMs, o.dayStartHour));
  learning.sort((a, b) => a.state!.card.due.getTime() - b.state!.card.due.getTime());
  // Review sort order: due date, then random (stable within a day).
  const dayOf = (i: QueueItem) => Math.floor(i.state!.card.due.getTime() / 86400000);
  // The day's shuffle key, hashed once per card (not once per comparison).
  const keys = new Map<QueueItem, string>();
  const key = (i: QueueItem) => {
    let k = keys.get(i);
    if (k === undefined) keys.set(i, (k = shortHash(i.ref.uid + dayKey, 6)));
    return k;
  };
  const rnd = (a: QueueItem, b: QueueItem) => (key(a) < key(b) ? -1 : 1);
  const ivl = (i: QueueItem) => i.state!.card.scheduled_days;
  // Relative overdueness: how late a card is compared with its interval (most overdue first).
  const overdue = (i: QueueItem) => (nowMs - i.state!.card.due.getTime()) / 86400000 / Math.max(1, ivl(i));
  switch (o.display?.reviewOrder ?? "due") {
    case "ivlAsc":
      review.sort((a, b) => ivl(a) - ivl(b) || rnd(a, b));
      break;
    case "ivlDesc":
      review.sort((a, b) => ivl(b) - ivl(a) || rnd(a, b));
      break;
    case "overdue":
      review.sort((a, b) => overdue(b) - overdue(a) || rnd(a, b));
      break;
    case "random":
      review.sort(rnd);
      break;
    default:
      review.sort((a, b) => dayOf(a) - dayOf(b) || rnd(a, b));
  }
  if (o.display?.newOrder === "random") fresh.sort(rnd);
  else fresh.sort((a, b) => a.ref.order - b.ref.order);

  // Per-deck stats, computed lazily, for per-deck limits.
  const byDeck = new Map<string, QueueItem[]>();
  if (limitsFor)
    for (const i of items) {
      const list = byDeck.get(i.ref.deck);
      if (list) list.push(i);
      else byDeck.set(i.ref.deck, [i]);
    }
  const deckStats = new Map<string, TodayStats>();
  const statsFor = (deck: string) => {
    let st = deckStats.get(deck);
    if (!st) {
      st = todayStats(byDeck.get(deck) ?? [], nowMs, o.dayStartHour);
      deckStats.set(deck, st);
    }
    return st;
  };
  const takenReview = new Map<string, number>();
  const takenNew = new Map<string, number>();

  let reviewsLeft = Math.max(0, o.reviewsPerDay - stats.reviewsDone);
  const reviewSlice: QueueItem[] = [];
  for (const item of review) {
    if (reviewsLeft <= 0) break;
    if (limitsFor) {
      const d = item.ref.deck;
      const own = limitsFor(d).reviewsPerDay - statsFor(d).reviewsDone - (takenReview.get(d) ?? 0);
      if (own <= 0) continue;
      takenReview.set(d, (takenReview.get(d) ?? 0) + 1);
    }
    reviewSlice.push(item);
    reviewsLeft--;
  }
  // New cards count against the review limit too, as in Anki v3 (unless "ignore review limit").
  const ignore = !!o.display?.newIgnoresReviewLimit;
  let newLeft = Math.max(0, ignore ? o.newPerDay - stats.newStudied : Math.min(o.newPerDay - stats.newStudied, reviewsLeft));
  const freshSlice: QueueItem[] = [];
  for (const item of fresh) {
    if (newLeft <= 0) break;
    if (limitsFor) {
      const d = item.ref.deck;
      const lim = limitsFor(d);
      const st = statsFor(d);
      const own = Math.min(
        lim.newPerDay - st.newStudied - (takenNew.get(d) ?? 0),
        ignore ? Number.MAX_SAFE_INTEGER : lim.reviewsPerDay - st.reviewsDone - (takenReview.get(d) ?? 0) - (takenNew.get(d) ?? 0),
      );
      if (own <= 0) continue;
      takenNew.set(d, (takenNew.get(d) ?? 0) + 1);
    }
    freshSlice.push(item);
    newLeft--;
  }
  // Adaptive new cards: while the learning pile is this big, new cards would only add to it.
  const paused = !!o.newPauseAbove && pile > o.newPauseAbove;
  return {
    learning,
    review: reviewSlice,
    fresh: paused ? [] : freshSlice,
    nextLearningDue: nextLearningDue !== undefined ? new Date(nextLearningDue) : undefined,
    mix: o.display?.newReviewMix,
    rested,
    pile,
    newHeld: paused ? freshSlice.length : 0,
  };
}

export function counts(q: Queue): { fresh: number; learning: number; review: number } {
  return { fresh: q.fresh.length, learning: q.learning.length, review: q.review.length };
}

/**
 * Pick the next card: a learning card that is due now comes first; otherwise new cards are
 * spread evenly among reviews; otherwise a learning card within the learn-ahead limit.
 */
export function nextCard(q: Queue, now: Date, answeredInSession: number): QueueItem | undefined {
  const nowMs = now.getTime();
  const dueLearning = q.learning.find((i) => i.state!.card.due.getTime() <= nowMs);
  if (dueLearning) return dueLearning;
  const nr = q.review.length;
  const nn = q.fresh.length;
  if (nr || nn) {
    if (!nn) return q.review[0];
    if (!nr) return q.fresh[0];
    if (q.mix === "after") return q.review[0];
    if (q.mix === "before") return q.fresh[0];
    const every = Math.max(1, Math.round((nr + nn) / nn));
    return answeredInSession % every === every - 1 ? q.fresh[0] : q.review[0];
  }
  return q.learning[0];
}

export function whichCount(item: QueueItem): "fresh" | "learning" | "review" {
  const s = item.state;
  if (!s || s.card.state === State.New) return "fresh";
  if (s.card.state === State.Learning || s.card.state === State.Relearning) {
    return isIntraday(s) ? "learning" : "review";
  }
  return "review";
}
