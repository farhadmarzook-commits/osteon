/**
 * Filtered decks and Custom Study (spec 0008), after Anki: a saved search that, when built,
 * takes a snapshot of matching cards in a chosen order. Cards leave the session once answered
 * (or, with rescheduling, once they graduate out of learning). Pure and tested.
 */
import { State } from "ts-fsrs";
import { shortHash } from "./hash";
import type { Queue, QueueItem } from "./queue";
import { compileSearch, type SearchContext } from "./search";

export type FilteredOrder = "random" | "due" | "lapses" | "intervalAsc" | "intervalDesc" | "notes";

export const FILTERED_ORDERS: Record<FilteredOrder, string> = {
  random: "Random",
  due: "Order due",
  lapses: "Most lapses",
  intervalAsc: "Increasing intervals",
  intervalDesc: "Decreasing intervals",
  notes: "Order in notes",
};

export interface FilteredDeck {
  id: string;
  name: string;
  search: string;
  limit: number;
  order: FilteredOrder;
  /** Anki's "Reschedule cards based on my answers": off = preview/cram, nothing is logged. */
  reschedule: boolean;
  /** Set by Build: when, and the card IDs (uid, or key once the card has one) in order. */
  builtAt?: number;
  cards?: string[];
}

/** Which cards a build takes, in order. Suspended and buried cards are never taken (as Anki). */
export function buildFiltered(
  items: QueueItem[],
  def: Pick<FilteredDeck, "search" | "limit" | "order">,
  nowMs: number,
  dayStartHour: number,
  ctx?: SearchContext,
): string[] {
  const match = compileSearch(def.search, nowMs, dayStartHour, ctx);
  const picked = items.filter((i) => match(i) && !i.state?.suspended && !((i.state?.buriedUntil ?? 0) > nowMs));
  const due = (i: QueueItem) => (i.state && i.state.card.state !== State.New ? i.state.card.due.getTime() : Number.MAX_SAFE_INTEGER);
  const ivl = (i: QueueItem) => i.state?.card.scheduled_days ?? 0;
  const salt = String(nowMs);
  const sorters: Record<FilteredOrder, (a: QueueItem, b: QueueItem) => number> = {
    random: (a, b) => (shortHash(a.ref.uid + salt, 8) < shortHash(b.ref.uid + salt, 8) ? -1 : 1),
    due: (a, b) => due(a) - due(b) || a.ref.order - b.ref.order,
    lapses: (a, b) => (b.state?.card.lapses ?? 0) - (a.state?.card.lapses ?? 0) || a.ref.order - b.ref.order,
    intervalAsc: (a, b) => ivl(a) - ivl(b) || a.ref.order - b.ref.order,
    intervalDesc: (a, b) => ivl(b) - ivl(a) || a.ref.order - b.ref.order,
    notes: (a, b) => a.ref.order - b.ref.order,
  };
  return picked
    .sort(sorters[def.order])
    .slice(0, Math.max(0, def.limit))
    .map((i) => i.ref.key ?? i.ref.uid);
}

function answeredSince(i: QueueItem, since: number): boolean {
  return !!i.state?.reviews.some((r) => Date.parse(r.ts) >= since);
}

/**
 * What's left of a built filtered deck, as a Queue the reviewer can use. With rescheduling,
 * a card answered since the build stays only while it's in (re)learning; without, `done` (the
 * cards the session has finished) is removed instead.
 */
export function filteredQueue(items: QueueItem[], def: FilteredDeck, nowMs: number, done: Set<string> = new Set()): Queue {
  const q: Queue = { learning: [], review: [], fresh: [] };
  if (!def.cards || def.builtAt === undefined) return q;
  const byId = new Map<string, QueueItem>();
  for (const i of items) {
    byId.set(i.ref.uid, i);
    if (i.ref.key) byId.set(i.ref.key, i);
  }
  let nextLearningDue: number | undefined;
  for (const id of def.cards) {
    const i = byId.get(id);
    if (!i || i.state?.suspended || (i.state?.buriedUntil ?? 0) > nowMs || done.has(id)) continue;
    if (def.reschedule && answeredSince(i, def.builtAt)) {
      const s = i.state!.card;
      if (s.state === State.Learning || s.state === State.Relearning) {
        q.learning.push(i);
        const d = s.due.getTime();
        if (d > nowMs && (nextLearningDue === undefined || d < nextLearningDue)) nextLearningDue = d;
      }
      continue;
    }
    if (!i.state || i.state.card.state === State.New) q.fresh.push(i);
    else q.review.push(i);
  }
  q.learning.sort((a, b) => a.state!.card.due.getTime() - b.state!.card.due.getTime());
  if (nextLearningDue !== undefined) q.nextLearningDue = new Date(nextLearningDue);
  return q;
}

/** Custom Study (Anki's dialog on a deck's overview). */
export type CustomStudyKind = "newLimit" | "reviewLimit" | "forgotten" | "ahead" | "preview" | "state";
export type CustomStudyState = "newRandom" | "due" | "reviewRandom" | "allRandom";

/** The filtered deck a Custom Study choice makes ("Custom Study Session", as in Anki). */
export function customStudyDeck(
  deck: string | null,
  kind: Exclude<CustomStudyKind, "newLimit" | "reviewLimit">,
  n: number,
  opts: { state?: CustomStudyState; tags?: string; limit?: number } = {},
): Omit<FilteredDeck, "id"> {
  const scope = deck ? `deck:"${deck}" ` : "";
  const name = "Custom Study Session";
  switch (kind) {
    case "forgotten":
      return { name, search: `${scope}rated:${n}:1`, limit: 9999, order: "random", reschedule: true };
    case "ahead":
      return { name, search: `${scope}-is:new prop:due<=${n}`, limit: 9999, order: "due", reschedule: true };
    case "preview":
      return { name, search: `${scope}is:new`, limit: n, order: "notes", reschedule: false };
    case "state": {
      const tags = (opts.tags ?? "")
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((t) => `tag:${t.replace(/^#/, "")}`)
        .join(" ");
      const limit = opts.limit ?? n;
      const st = opts.state ?? "due";
      const stateTerm = st === "newRandom" ? "is:new" : st === "due" ? "is:due" : st === "reviewRandom" ? "-is:new" : "";
      const search = [scope.trim(), stateTerm, tags].filter(Boolean).join(" ");
      return { name, search, limit, order: st === "due" ? "due" : "random", reschedule: st !== "allRandom" };
    }
  }
}
