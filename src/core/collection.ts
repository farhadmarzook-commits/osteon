/** Joins parsed cards (from notes) with derived state (from logs). */
import type { ParsedCard } from "./parser";
import type { CardState } from "./state";

export interface CardRef {
  /** `<id>.<slot>`, or undefined for a card that has never been reviewed (no ID yet). */
  key?: string;
  /** Stable within a session: the key, or a path/line-based stand-in for new cards. */
  uid: string;
  card: ParsedCard;
  slot: string;
  path: string;
  deck: string;
  /** Position in note order, for "new cards follow note order" (spec 0003 §5). */
  order: number;
}

export const DEFAULT_DECK = "Default";

/**
 * Deck for a note (spec 0002 §4): the `#flashcards/...` sub-tag if present, else the folder.
 * `tags` are the note's tags without `#`.
 */
/**
 * A note's deck: an imported Anki deck's own name (frontmatter `anki-deck`, which keeps spaces
 * and punctuation a tag can't), else the `#flashcards/…` sub-tag, else the folder, else Default.
 */
export function deckFor(path: string, tags: string[], ankiDeck?: unknown): string {
  if (typeof ankiDeck === "string" && ankiDeck.trim()) {
    const parts = ankiDeck
      .split("::")
      .map((p) => p.replace(/\//g, "-").trim())
      .filter(Boolean);
    if (parts.length) {
      parts[0] = parts[0].replace(/^#+/, "") || parts[0];
      return parts.join("/");
    }
  }
  for (const t of tags) {
    const m = /^flashcards\/(.+)$/i.exec(t);
    if (m) return m[1];
  }
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : DEFAULT_DECK;
}

export function refsForNote(path: string, deck: string, cards: ParsedCard[], orderBase: number): CardRef[] {
  const refs: CardRef[] = [];
  let order = orderBase;
  for (const card of cards) {
    for (const slot of card.slots) {
      const key = card.id ? `${card.id}.${slot}` : undefined;
      refs.push({
        key,
        uid: key ?? `new:${path}:${card.startLine}:${slot}`,
        card,
        slot,
        path,
        deck,
        order: order++,
      });
    }
  }
  return refs;
}

/** True if `deck` is `parent` or one of its sub-decks. Case-insensitive, like Obsidian tags. */
export function inDeck(deck: string, parent: string): boolean {
  const d = deck.toLowerCase();
  const p = parent.toLowerCase();
  return d === p || d.startsWith(p + "/");
}

/**
 * Detect an edited `==cloze==` (spec 0002 §3.4): if exactly one slot with history has
 * disappeared from a card and exactly one new slot without history has appeared, they are the
 * same cloze. Returns the alias to log, or null.
 */
export function findClozeAlias(
  card: ParsedCard,
  historicalSlots: string[],
): { from: string; to: string } | null {
  if (!card.id || card.type !== "cloze") return null;
  const current = new Set(card.slots);
  const missing = historicalSlots.filter((s) => s.startsWith("x") && !current.has(s));
  const hist = new Set(historicalSlots);
  const fresh = card.slots.filter((s) => s.startsWith("x") && !hist.has(s));
  if (missing.length === 1 && fresh.length === 1) {
    return { from: `${card.id}.${missing[0]}`, to: `${card.id}.${fresh[0]}` };
  }
  return null;
}

/**
 * Slots with history for every card ID, in one pass over the states (keys are `<id>.<slot>`; IDs
 * never contain a dot). Calling slotsWithHistory per card is O(cards × states): 22 s on 47k cards.
 */
export function slotsById(states: Map<string, CardState>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, s] of states) {
    if (!s.reviews.length) continue;
    const dot = key.indexOf(".");
    if (dot < 0) continue;
    const id = key.slice(0, dot);
    const list = out.get(id);
    if (list) list.push(key.slice(dot + 1));
    else out.set(id, [key.slice(dot + 1)]);
  }
  return out;
}

/** Slots that have state for a given card ID. */
export function slotsWithHistory(id: string, states: Map<string, CardState>): string[] {
  const out: string[] = [];
  const prefix = id + ".";
  for (const [key, s] of states) {
    if (key.startsWith(prefix) && s.reviews.length) out.push(key.slice(prefix.length));
  }
  return out;
}

/**
 * Hidden decks (settings.hiddenDecks): a card is left out of what you study from `studied` (null =
 * every deck) when its deck sits inside a hidden deck that `studied` itself is not inside. So
 * "Study all" and a visible parent skip hidden decks, but opening a hidden deck still studies it.
 */
export function hiddenFrom(deck: string, studied: string | null, hidden: readonly string[]): boolean {
  for (const h of hidden) {
    if (!inDeck(deck, h)) continue;
    if (studied === null || !inDeck(studied, h)) return true;
  }
  return false;
}

/** Whether `deck` is a hidden deck or sits inside one. */
export function inHiddenDeck(deck: string, hidden: readonly string[]): boolean {
  return hidden.some((h) => inDeck(deck, h));
}

/** A deck rename (Anki's Rename): `from` and its sub-decks show as `to`. Applied in order. */
export interface DeckRename {
  from: string;
  to: string;
}

/** A deck's name after the user's renames. Rules apply in order, so a renamed deck can be renamed again. */
export function renamedDeck(deck: string, renames: readonly DeckRename[]): string {
  let d = deck;
  for (const r of renames) if (inDeck(d, r.from)) d = r.to + d.slice(r.from.length);
  return d;
}

/** Tidy a typed deck name: Anki's `::` or `/` both separate sub-decks; blank parts are dropped. */
export function cleanDeckName(name: string): string {
  return name
    .split(/::|\//)
    .map((p) => p.trim())
    .filter(Boolean)
    .join("/");
}

/**
 * Add the rename `from` → `to` to the list. Renaming the result of the last rule again updates
 * that rule rather than stacking another, and a rule that ends where it started is dropped.
 */
export function addRename(renames: readonly DeckRename[], from: string, to: string): DeckRename[] {
  const out = renames.map((r) => ({ ...r }));
  const last = out[out.length - 1];
  if (last && last.to.toLowerCase() === from.toLowerCase()) {
    last.to = to;
    if (last.from === last.to) out.pop();
    return out;
  }
  out.push({ from, to });
  return out;
}

/** Move per-deck settings keyed by lower-cased deck path (presets, limits, hidden) along with a rename. */
export function moveDeckKey(key: string, from: string, to: string): string {
  return inDeck(key, from) ? (to + key.slice(from.length)).toLowerCase() : key;
}
