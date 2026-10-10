/**
 * Leeches: cards forgotten again and again (Anki: lapses ≥ the deck's leech threshold). The Leeches
 * screen lists them so each can be rewritten, split into crowns, given another go, or dropped.
 */
export interface LeechItem {
  ref: { key?: string; deck: string };
  state?: { card: { lapses: number }; suspended?: boolean };
}

/**
 * Cards at or past their deck's threshold (0 = leeches off for that deck), most lapses first.
 * A card dealt with on the screen (`done`: key → its lapses then) comes back only if it lapses
 * another half-threshold times, the same step at which Anki flags a leech again.
 */
export function findLeeches<T extends LeechItem>(items: readonly T[], thresholdFor: (deck: string) => number, done: Record<string, number>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const i of items) {
    const key = i.ref.key;
    const lapses = i.state?.card.lapses ?? 0;
    if (!key || seen.has(key) || lapses === 0) continue;
    const t = thresholdFor(i.ref.deck);
    if (t <= 0 || lapses < t) continue;
    const at = done[key];
    if (at !== undefined && lapses < at + Math.max(1, Math.ceil(t / 2))) continue;
    seen.add(key);
    out.push(i);
  }
  return out.sort((a, b) => (b.state?.card.lapses ?? 0) - (a.state?.card.lapses ?? 0));
}
