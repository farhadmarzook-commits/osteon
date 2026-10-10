/**
 * Weak spots: the cards missed most over a period, and the miss rate by topic. Pure and tested; the
 * screen lives in plugin/views/weak.ts.
 */
import type { CardRef } from "./collection";
import type { QueueItem } from "./queue";

export interface WeakCard {
  item: QueueItem;
  /** Times answered Again in the period. */
  misses: number;
  answers: number;
}

export interface TopicStat {
  topic: string;
  cards: number;
  answers: number;
  misses: number;
  /** misses / answers, 0..1. */
  rate: number;
}

const ORTHOBULLETS = /orthobullets\.com\/([a-z][a-z-]+)\/\d+\//i;
const SMALL = new Set(["and", "of", "the"]);

/**
 * A card's topic: for cards that cite an Orthobullets page, that page's section ("Shoulder & Elbow"),
 * since one imported deck can span every subspecialty; otherwise the card's deck (its last part).
 */
export function topicOf(ref: CardRef): string {
  const m = ORTHOBULLETS.exec(ref.card.back) ?? ORTHOBULLETS.exec(ref.card.front);
  if (m) {
    return m[1]
      .toLowerCase()
      .split("-")
      .map((w) => (w === "and" ? "&" : SMALL.has(w) ? w : w[0].toUpperCase() + w.slice(1)))
      .join(" ");
  }
  const parts = ref.deck.split("/");
  return parts[parts.length - 1].replace(/^\d+\)\s*/, "").replace(/_/g, " ");
}

function tally(item: QueueItem, sinceMs: number): { misses: number; answers: number } {
  let misses = 0;
  let answers = 0;
  const reviews = item.state?.reviews ?? [];
  for (let k = reviews.length - 1; k >= 0; k--) {
    const r = reviews[k];
    if (Date.parse(r.ts) < sinceMs) break;
    answers++;
    if (r.rating === "again") misses++;
  }
  return { misses, answers };
}

/** Cards answered Again at least `minMisses` times since `sinceMs`, most missed first. */
export function weakCards(items: readonly QueueItem[], sinceMs: number, minMisses: number): WeakCard[] {
  const out: WeakCard[] = [];
  for (const item of items) {
    if (!item.state?.reviews.length) continue;
    const t = tally(item, sinceMs);
    if (t.misses >= minMisses) out.push({ item, ...t });
  }
  return out.sort((a, b) => b.misses - a.misses || b.answers - a.answers || a.item.ref.order - b.item.ref.order);
}

/** Miss rate by topic since `sinceMs`, worst first; topics with fewer than `minAnswers` answers are left out. */
export function topicStats(items: readonly QueueItem[], sinceMs: number, minAnswers = 5): TopicStat[] {
  const by = new Map<string, TopicStat>();
  for (const item of items) {
    if (!item.state?.reviews.length) continue;
    const t = tally(item, sinceMs);
    if (!t.answers) continue;
    const topic = topicOf(item.ref);
    let s = by.get(topic);
    if (!s) by.set(topic, (s = { topic, cards: 0, answers: 0, misses: 0, rate: 0 }));
    s.cards++;
    s.answers += t.answers;
    s.misses += t.misses;
  }
  const out = [...by.values()].filter((s) => s.answers >= minAnswers);
  for (const s of out) s.rate = s.misses / s.answers;
  return out.sort((a, b) => b.rate - a.rate || b.misses - a.misses || a.topic.localeCompare(b.topic));
}
