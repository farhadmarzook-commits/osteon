/** Turns a parsed card + slot into the Markdown shown on each side (spec 0002 §2, 0003 §1.3). */
import { occlusionTitle } from "./occlusion";
import type { ParsedCard } from "./parser";

export interface CardFaces {
  kind: "cloze" | "basic" | "occlusion";
  /** Shown before the answer. */
  question: string;
  /**
   * Cloze: the front again with the answer revealed (replaces the question).
   * Basic: the answer, shown under a rule below the question.
   */
  answer: string;
  /** Back lines (Anki's Back Extra). */
  extra: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/**
 * How a revealed answer is broken into separately revealed pieces (👑):
 * - "lines": a list kept on separate lines inside ONE cloze (`{{c1::A <br> B <br> C}}`)
 * - "lists": also split at top-level commas and "and" (only when a card is switched to crowns by hand)
 * - "none": one piece per cloze
 */
export type CrownSplit = "lines" | "lists" | "none";

const LINE_BREAK = /(\s*(?:<br\s*\/?>|\n)\s*)/i;

/** Pieces of one answer plus the separators between them (sep[i] follows item[i]). */
export function answerItems(answer: string, split: CrownSplit): { items: string[]; seps: string[] } {
  if (split === "none") return { items: [answer], seps: [""] };
  // Lead/trail line breaks belong outside the pieces.
  const lead = answer.match(/^(?:\s*(?:<br\s*\/?>|\n))+\s*/i)?.[0] ?? "";
  const trail = answer.slice(lead.length).match(/(?:\s*(?:<br\s*\/?>|\n))+\s*$/i)?.[0] ?? "";
  const body = answer.slice(lead.length, answer.length - trail.length);
  const parts = body.split(new RegExp(LINE_BREAK.source, "gi"));
  let items: string[] = [];
  let seps: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    items.push(parts[i]);
    seps.push(parts[i + 1] ?? "");
  }
  if (split === "lists" && items.length === 1) ({ items, seps } = splitCommas(body));
  else if (split === "lines" && items.length === 1 && hasTopLevelAmp(body)) {
    // "A & B" (or "A, B, & C") is a list too — unless it's one name with a shared noun,
    // like "Lewis & Rorabeck classification" or "posterior & superior AC ligaments".
    const r = splitCommas(body);
    if (r.items.length > 1 && !sharedNoun(r.items)) ({ items, seps } = r);
  }
  // A blank piece (two breaks in a row) joins the separator before it.
  const keptItems: string[] = [];
  const keptSeps: string[] = [];
  items.forEach((x, i) => {
    if (x.trim() === "" && keptItems.length) keptSeps[keptSeps.length - 1] += x + seps[i];
    else {
      keptItems.push(x);
      keptSeps.push(seps[i]);
    }
  });
  if (keptItems.every((x) => x.trim() === "")) return { items: [answer], seps: [""] };
  return { items: keptItems, seps: keptSeps };
}

/** `A, B, and C` / `A and B` at the top level (not inside brackets or HTML tags). */
function splitCommas(s: string): { items: string[]; seps: string[] } {
  const items: string[] = [];
  const seps: string[] = [];
  let depth = 0;
  let inTag = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag && "([{".includes(ch)) depth++;
    else if (!inTag && ")]}".includes(ch)) depth = Math.max(0, depth - 1);
    if (inTag || depth > 0) continue;
    const m = s.slice(i).match(/^(,\s*(?:(?:and|or|&|&amp;)\s+)?|\s+(?:and|or|&|&amp;)\s+)/i);
    if (m && i > start) {
      items.push(s.slice(start, i));
      seps.push(m[0]);
      i += m[0].length - 1;
      start = i + 1;
    }
  }
  items.push(s.slice(start));
  seps.push("");
  return { items, seps };
}

const AMP = /\s(?:&|&amp;)\s/;

/** " & " outside brackets. */
function hasTopLevelAmp(s: string): boolean {
  return AMP.test(s.replace(/\([^)]*\)|\[[^\]]*\]|<[^>]*>/g, (m) => "x".repeat(m.length)));
}

/** Words of a piece, ignoring Markdown/HTML and bracketed asides. */
function plainWords(s: string): string[] {
  return s.replace(/<[^>]*>|\*\*|__|\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean);
}

/** "Lewis & Rorabeck classification": one-word first piece, the noun on the last one. */
function sharedNoun(items: string[]): boolean {
  // A first piece with its own (aside) stands alone: "anterolateral (Watson-Jones) & direct lateral (Hardinge)".
  if (items[0].includes("(")) return false;
  return plainWords(items[0]).length === 1 && plainWords(items[items.length - 1]).length > 1;
}

function revealedAnswer(answer: string, split: CrownSplit): string {
  const { items, seps } = answerItems(answer, split);
  if (items.length === 1 && items[0] === answer) return `<mark class="fc-answer">${answer}</mark>`;
  const lead = split === "none" ? "" : (answer.match(/^(?:\s*(?:<br\s*\/?>|\n))+\s*/i)?.[0] ?? "");
  const rest = answer.slice(lead.length);
  const trail = split === "none" ? "" : (rest.match(/(?:\s*(?:<br\s*\/?>|\n))+\s*$/i)?.[0] ?? "");
  if (items.length === 1) return `${lead}<mark class="fc-answer">${items[0]}</mark>${trail}`;
  return lead + items.map((x, i) => `<mark class="fc-answer">${x}</mark>${seps[i]}`).join("") + trail;
}

export function clozeFront(card: ParsedCard, slot: string, reveal: boolean, split: CrownSplit = "none"): string {
  let out = "";
  let pos = 0;
  for (const c of card.clozes) {
    out += card.front.slice(pos, c.start);
    if (c.slot === slot) {
      // A real <mark>, not `==…==`: stray `**` elsewhere on the line (common in Anki imports) can
      // stop `==` from parsing, and the crowns need a <mark> per answer.
      out += reveal
        ? revealedAnswer(c.answer, split)
        : `<span class="fc-cloze">[${escapeHtml(c.hint ?? "...")}]</span>`;
    } else {
      out += c.answer;
    }
    pos = c.end;
  }
  return out + card.front.slice(pos);
}

export function cardFaces(card: ParsedCard, slot: string, split: CrownSplit = "none"): CardFaces {
  if (card.type === "occlusion" && card.occlusion) {
    // The figure itself is drawn by the reviewer; these are the texts around it.
    return { kind: "occlusion", question: card.front || occlusionTitle(card.occlusion, slot), answer: occlusionTitle(card.occlusion, slot), extra: card.back };
  }
  if (card.type === "cloze") {
    return {
      kind: "cloze",
      question: clozeFront(card, slot, false),
      answer: clozeFront(card, slot, true, split),
      extra: card.back,
    };
  }
  let question = card.front;
  let answer = card.answer;
  let extra = card.back;
  if (answer === "") {
    // `Question ::` with the answer on the lines below (spec 0002 §2, "longer answer").
    answer = extra;
    extra = "";
  }
  if (card.type === "reversed" && slot === "rev") [question, answer] = [answer, question];
  return { kind: "basic", question, answer, extra };
}

/**
 * Anki's "cloze one by one" (the AnKing crown feature): on the back, each answer this card asks
 * for starts hidden as 👑 and is revealed one at a time. On when the card asks for at least
 * `minAnswers` answers (0 = never), counting each line of a one-cloze list as an answer.
 * `override` is the reviewer's per-card switch: true = always crowns (lists split at commas too),
 * false = never.
 */
export function revealsOneByOne(card: ParsedCard, slot: string, minAnswers: number, override?: boolean): boolean {
  if (card.type !== "cloze" || override === false) return false;
  if (override === true) return card.clozes.some((c) => c.slot === slot);
  if (minAnswers <= 0) return false;
  return answerCount(card, slot, "lines") >= minAnswers;
}

/** How a card's revealed answer is split for the crowns (matches revealsOneByOne). */
export function crownSplit(card: ParsedCard, slot: string, minAnswers: number, override?: boolean): CrownSplit {
  if (!revealsOneByOne(card, slot, minAnswers, override)) return "none";
  return override === true ? "lists" : "lines";
}

function answerCount(card: ParsedCard, slot: string, split: CrownSplit): number {
  return card.clozes.filter((c) => c.slot === slot).reduce((n, c) => n + answerItems(c.answer, split).items.length, 0);
}
