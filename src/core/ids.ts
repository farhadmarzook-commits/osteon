import type { ParsedCard } from "./parser";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
export const ID_PATTERN = /(?:^|\s)\^fc-([a-z0-9]{8})\s*$/;

/** A new card ID: 8 random base-36 characters (spec 0001 §4.1). */
export function newCardId(taken: (id: string) => boolean = () => false): string {
  for (;;) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let id = "";
    for (const b of bytes) id += ALPHABET[b % 36];
    if (!taken(id)) return id;
  }
}

/**
 * Write `^fc-<id>` into a note's text for one card, following Obsidian's block-ID rules
 * (spec 0002 §3.5). Returns null if the card's lines no longer match what was parsed, so a
 * stale index never writes into the wrong place.
 */
export function insertCardId(text: string, card: ParsedCard, id: string): string | null {
  const lines = text.split("\n");
  for (let i = card.startLine; i <= card.endLine; i++) {
    if (lines[i] !== card.sourceLines[i - card.startLine]) return null;
  }
  if (card.id) return null;
  const target = card.idLine;
  if (card.idMode === "before") {
    const indent = /^\s*/.exec(lines[target])?.[0] ?? "";
    lines.splice(target, 0, `${indent}id: fc-${id}`);
  } else {
    lines[target] = `${lines[target].trimEnd()} ^fc-${id}`;
  }
  return lines.join("\n");
}

/**
 * Replace a card's lines with edited text (the inline editor, spec 0003 §3). Returns null if the
 * card's lines no longer match what was parsed.
 */
export function replaceCardSource(text: string, card: ParsedCard, source: string): string | null {
  const lines = text.split("\n");
  for (let i = card.startLine; i <= card.endLine; i++) {
    if (lines[i] !== card.sourceLines[i - card.startLine]) return null;
  }
  const replacement = source.replace(/\n+$/, "").split("\n");
  lines.splice(card.startLine, card.endLine - card.startLine + 1, ...replacement);
  return lines.join("\n");
}

/**
 * New source lines for a card rewritten as a short front plus back lines (the AI "split"
 * suggestion), keeping its form (paragraph or bullet) and its ID so its history carries over.
 */
export function composeCardSource(card: ParsedCard, front: string, back: string[]): string {
  const id = card.id ? ` ^fc-${card.id}` : "";
  const clean = (s: string) => s.replace(/\n+/g, " ").trim();
  const lines = back.map(clean).filter(Boolean);
  // Cards inside a card callout keep their "> " on every line.
  const q = card.quote ?? "";
  const first = q ? card.sourceLines[0].slice(q.length) : card.sourceLines[0];
  let out: string[];
  if (card.form === "list") {
    const m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(first) ?? ["", "", "-"];
    const indent = m[1];
    out = [`${indent}${m[2]} ${clean(front)}${id}`, ...lines.map((b) => `${indent}    - ${b}`)];
  } else {
    out = [clean(front), ...lines];
    out[out.length - 1] += id;
  }
  return out.map((l) => q + l).join("\n");
}
