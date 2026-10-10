/**
 * Card parser (spec 0002). Pure: note text in, cards out. No Obsidian imports, so it runs
 * under vitest.
 *
 * The one rule: a card is a paragraph's first line or a list item that contains a card
 * marker; the lines under it are its back.
 */
import { shortHash } from "./hash";
import { ID_PATTERN } from "./ids";
import { OCCLUSION_LANG, occlusionSlots, parseOcclusion, type Occlusion } from "./occlusion";

export type CardType = "cloze" | "basic" | "reversed" | "occlusion";

export interface ClozeSpan {
  /** Offsets into ParsedCard.front. */
  start: number;
  end: number;
  answer: string;
  hint?: string;
  slot: string;
}

export interface ParsedCard {
  type: CardType;
  /** The 8-character ID from `^fc-<id>`, if the card has one. */
  id?: string;
  form: "paragraph" | "list";
  startLine: number;
  endLine: number;
  /** Where `^fc-<id>` goes (spec 0002 §3.5). */
  idLine: number;
  /** "append": add ` ^fc-<id>` to idLine. "before": insert an `id: fc-<id>` line before idLine
   *  (occlusion blocks keep their ID inside the block, spec 0004 §2). */
  idMode: "append" | "before";
  /** The figure's masks, for image-occlusion cards. */
  occlusion?: Occlusion;
  /** The raw lines startLine..endLine, used to check the note hasn't changed before writing. */
  sourceLines: string[];
  /** Set for cards inside a card callout (spec 0002 §3.2): the "> " prefix their lines carry. */
  quote?: string;
  /** Front line: list marker, ID, tags and SR comments removed. Cloze markers kept. */
  front: string;
  /** Basic and reversed: the text after `::` / `:::`. */
  answer: string;
  /** The lines under the front (Anki's Back Extra), dedented. */
  back: string;
  clozes: ClozeSpan[];
  /** Sub-card slots in order of appearance (spec 0001 §4.1). */
  slots: string[];
  tags: string[];
  /** Heading trail above the card, outermost first. */
  headings: string[];
  /** Short hash of the card's content, logged with each review (spec 0001 §4.2). */
  hash: string;
  /** Image embeds elsewhere under the same heading, for the back (spec 0002 §5). */
  sectionImages: string[];
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(\[.\]\s+)?/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const OCCLUSION_FENCE = new RegExp(`^\\s*(\`{3,}|~{3,})\\s*${OCCLUSION_LANG}\\s*$`);
const INLINE_SR_COMMENT_RE = /\s*<!--SR:.*?-->/g;
/** Drop old Spaced Repetition comments (the regex is slow on long lines, so check first). */
function dropSrComments(s: string): string {
  return s.includes("<!--SR:") ? s.replace(INLINE_SR_COMMENT_RE, "") : s;
}
const TAG = /(^|\s)(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const CLOZE_HL = /(?<!\\)==(?!=)([^\n]+?)(?<!\\)==/g;
const CLOZE_ANKI = /\{\{c(\d+)::([\s\S]+?)(?:::([^}]*?))?\}\}/g;

function indentWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === " ") w += 1;
    else if (ch === "\t") w += 4;
    else break;
  }
  return w;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isPureComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("<!--") && t.endsWith("-->");
}

/** Replace inline code spans with spaces so markers inside them are ignored. */
function maskInlineCode(s: string): string {
  if (!s.includes("`")) return s;
  return s.replace(/(`+)([\s\S]*?)\1/g, (m) => " ".repeat(m.length));
}

function normaliseClozeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?]+$/, "");
}

export function clozeSlotForText(answer: string): string {
  return "x" + shortHash(normaliseClozeText(answer));
}

/**
 * obsidian-spaced-repetition's highlight cloze: `==[group;;]answer[;;hint]==`.
 * "==Anchoring;;which bias?==" is answer + hint; "==1;;radial==" puts the cloze in group 1
 * (like Anki's c1: same-numbered clozes are hidden together on one card).
 */
export function splitSrCloze(inner: string): { answer: string; hint?: string; slot: string } | null {
  const parts = inner.split(";;");
  let group: string | undefined;
  let answer: string;
  let hint: string | undefined;
  if (parts.length >= 2 && /^\s*\d+\s*$/.test(parts[0])) {
    group = parts[0].trim();
    answer = parts[1];
    hint = parts.length > 2 ? parts.slice(2).join(";;") : undefined;
  } else {
    answer = parts[0];
    hint = parts.length > 1 ? parts.slice(1).join(";;") : undefined;
  }
  if (!answer.trim()) return null;
  hint = hint?.trim() || undefined;
  return { answer, hint, slot: group ? "c" + Number(group) : clozeSlotForText(answer) };
}

function stripId(line: string): { text: string; id?: string } {
  const m = ID_PATTERN.exec(line);
  if (!m) return { text: line };
  return { text: line.slice(0, m.index).trimEnd(), id: m[1] };
}

function extractTags(front: string): { text: string; tags: string[] } {
  const masked = maskInlineCode(front);
  const tags: string[] = [];
  const cuts: Array<[number, number]> = [];
  for (const m of masked.matchAll(TAG)) {
    const tag = m[2];
    const start = (m.index ?? 0) + m[1].length;
    cuts.push([start, start + tag.length]);
    const name = tag.slice(1);
    if (!/^flashcards(\/|$)/i.test(name)) tags.push(name);
  }
  let text = front;
  for (let i = cuts.length - 1; i >= 0; i--) {
    text = text.slice(0, cuts[i][0]) + text.slice(cuts[i][1]);
  }
  return { text: text.replace(/[ \t]{2,}/g, " ").trim(), tags };
}

interface Markers {
  type: CardType | null;
  splitAt?: number;
  splitLen?: number;
  clozes: ClozeSpan[];
}

function findMarkers(front: string): Markers {
  const masked = maskInlineCode(front);
  // Hide Anki clozes before looking for `::`, since `{{c1::x}}` contains it.
  const hasAnki = masked.includes("{{c");
  const noAnki = hasAnki ? masked.replace(CLOZE_ANKI, (m) => " ".repeat(m.length)) : masked;
  const rev = noAnki.indexOf(":::");
  if (rev >= 0) return { type: "reversed", splitAt: rev, splitLen: 3, clozes: [] };
  const basic = noAnki.indexOf("::");
  if (basic >= 0) return { type: "basic", splitAt: basic, splitLen: 2, clozes: [] };

  const clozes: ClozeSpan[] = [];
  if (hasAnki) for (const m of masked.matchAll(CLOZE_ANKI)) {
    const start = m.index ?? 0;
    const raw = front.slice(start, start + m[0].length);
    const inner = /^\{\{c(\d+)::([\s\S]+?)(?:::([^}]*?))?\}\}$/.exec(raw);
    if (!inner) continue;
    clozes.push({
      start,
      end: start + m[0].length,
      answer: inner[2],
      hint: inner[3] || undefined,
      slot: "c" + Number(inner[1]),
    });
  }
  if (noAnki.includes("==")) for (const m of noAnki.matchAll(CLOZE_HL)) {
    const start = m.index ?? 0;
    const c = splitSrCloze(front.slice(start + 2, start + m[0].length - 2));
    if (!c) continue;
    clozes.push({ start, end: start + m[0].length, ...c });
  }
  clozes.sort((a, b) => a.start - b.start);
  return { type: clozes.length ? "cloze" : null, clozes };
}

/** Does this line carry a card marker of its own? */
function hasMarker(line: string): boolean {
  // Every marker (`::`, `:::`, `==…==`, `{{c1::…}}`) needs one of these; most lines have neither.
  if (!line.includes("::") && !line.includes("==")) return false;
  const li = LIST_ITEM.exec(line);
  const body = li ? line.slice(li[0].length) : line;
  const front = extractTags(dropSrComments(stripId(body).text)).text;
  return findMarkers(front).type !== null;
}

function dedent(lines: string[]): string {
  const nonBlank = lines.filter((l) => !isBlank(l));
  if (nonBlank.length === 0) return "";
  const min = Math.min(...nonBlank.map(indentWidth));
  return lines
    .map((l) => {
      let w = 0;
      let i = 0;
      while (i < l.length && w < min) {
        w += l[i] === "\t" ? 4 : 1;
        i++;
      }
      return l.slice(i);
    })
    .join("\n")
    .trim();
}

function buildCard(
  frontRaw: string,
  backLines: string[],
  allLines: string[],
  startLine: number,
  endLine: number,
  idLine: number,
  form: "paragraph" | "list",
  headings: string[],
): ParsedCard | null {
  let id: string | undefined;
  const cleanBack = backLines.map((l) => {
    const s = stripId(l);
    if (s.id && !id) id = s.id;
    return dropSrComments(s.text);
  });
  const f = stripId(frontRaw);
  if (f.id) id = f.id;
  const { text: front, tags } = extractTags(dropSrComments(f.text));
  const markers = findMarkers(front);
  if (!markers.type) return null;

  const back = form === "list" ? dedent(cleanBack) : cleanBack.join("\n").trim();
  let cardFront = front;
  let answer = "";
  let slots: string[];
  if (markers.type === "cloze") {
    slots = [...new Set(markers.clozes.map((c) => c.slot))];
  } else {
    cardFront = front.slice(0, markers.splitAt).trim();
    answer = front.slice((markers.splitAt ?? 0) + (markers.splitLen ?? 0)).trim();
    slots = markers.type === "reversed" ? ["fwd", "rev"] : ["fwd"];
  }
  return {
    type: markers.type,
    id,
    form,
    startLine,
    endLine,
    idLine,
    idMode: "append",
    sourceLines: allLines.slice(startLine, endLine + 1),
    front: cardFront,
    answer,
    back,
    clozes: markers.type === "cloze" ? markers.clozes : [],
    slots,
    tags,
    headings: [...headings],
    hash: shortHash(`${cardFront}\n${answer}\n${back}`),
    sectionImages: [],
  };
}

/** An image-occlusion block: the fence, its masks, and the lines under it as the back. */
function buildOcclusionCard(lines: string[], open: number, close: number, headings: string[]): ParsedCard | null {
  if (close >= lines.length) return null;
  const occ = parseOcclusion(lines.slice(open + 1, close).join("\n"));
  if (!occ.image) return null;
  let end = close;
  let j = close + 1;
  while (j < lines.length && !isBlank(lines[j]) && !HEADING.test(lines[j]) && !FENCE.test(lines[j]) && !hasMarker(lines[j])) {
    end = j;
    j++;
  }
  const back = lines.slice(close + 1, end + 1).filter((l) => !isPureComment(l)).join("\n").trim();
  const slots = occlusionSlots(occ);
  if (!slots.length) return null;
  return {
    type: "occlusion",
    id: occ.id,
    form: "paragraph",
    startLine: open,
    endLine: end,
    idLine: close,
    idMode: "before",
    occlusion: occ,
    sourceLines: lines.slice(open, end + 1),
    front: occ.header ?? "",
    answer: "",
    back,
    clozes: [],
    slots,
    tags: [],
    headings: [...headings],
    hash: shortHash(lines.slice(open, close + 1).join("\n") + "\n" + back),
    sectionImages: [],
  };
}

const IMAGE_EXT = "png|jpe?g|gif|webp|svg|bmp|avif";
const IMAGE_EMBED = new RegExp(
  `!\\[\\[[^\\]|#]+\\.(?:${IMAGE_EXT})(?:[|#][^\\]]*)?\\]\\]|!\\[[^\\]]*\\]\\([^)\\s]+\\.(?:${IMAGE_EXT})(?:\\s[^)]*)?\\)`,
  "gi",
);

/** Image embeds (`![[x.png]]`, `![](x.png)`) in a piece of Markdown. */
export function imageEmbeds(markdown: string): string[] {
  return markdown.match(IMAGE_EMBED) ?? [];
}

/** At most this many section figures are kept per card (the deck option allows up to 6). */
const MAX_SECTION_IMAGES = 6;

/**
 * Figures from each card's heading section (spec 0002 §5). Each section's images are collected
 * once, then shared by its cards, so a big note with one heading (an Anki import: 300 cards)
 * stays linear instead of scanning the whole note for every card.
 */
function fillSectionImages(lines: string[], cards: ParsedCard[], headingLines: number[]): void {
  const bounds = [-1, ...headingLines.filter((h) => h >= 0).sort((a, b) => a - b), lines.length];
  const sectionOf = (line: number) => {
    let k = 0;
    while (k + 1 < bounds.length && bounds[k + 1] <= line) k++;
    return k;
  };
  const cache = new Map<number, Array<{ line: number; img: string }>>();
  const imagesIn = (k: number) => {
    let found = cache.get(k);
    if (found) return found;
    found = [];
    let inFence = false;
    for (let i = bounds[k] + 1; i < bounds[k + 1]; i++) {
      if (FENCE.test(lines[i])) inFence = !inFence;
      if (inFence || !lines[i].includes("![")) continue;
      for (const img of imageEmbeds(lines[i])) found.push({ line: i, img });
    }
    cache.set(k, found);
    return found;
  };
  for (const card of cards) {
    const images: string[] = [];
    for (const { line, img } of imagesIn(sectionOf(card.startLine))) {
      if (line >= card.startLine && line <= card.endLine) continue;
      if (!images.includes(img)) images.push(img);
      if (images.length >= MAX_SECTION_IMAGES) break;
    }
    card.sectionImages = images;
  }
}

/** Callout types whose contents are cards: `> [!card]`, `> [!flashcards] Optional title`… */
export const CARD_CALLOUTS = new Set(["card", "cards", "flashcard", "flashcards"]);
const CALLOUT_HEAD = /^\s*>\s*\[!([\w-]+)\][+-]?/;
/** One level of quote marker, keeping what follows (e.g. "> > x" → "> x", ">x" → "x"). */
const QUOTE = /^(\s*>\s?)/;

export function parseNote(text: string): ParsedCard[] {
  const lines = text.split("\n");
  const cards: ParsedCard[] = [];
  const headingStack: Array<{ level: number; text: string }> = [];
  const headingLines: number[] = [];
  const n = lines.length;
  let i = 0;
  let inList = false;
  let prevBlank = true;

  // Frontmatter.
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < n && lines[i].trim() !== "---" && lines[i].trim() !== "...") i++;
    i++;
  }

  const skipFence = (from: number): number => {
    const open = FENCE.exec(lines[from]);
    const marker = open ? open[1] : "```";
    let j = from + 1;
    while (j < n && !lines[j].trim().startsWith(marker[0].repeat(marker.length))) j++;
    return j; // index of the closing fence (or n)
  };
  const skipMath = (from: number): number => {
    const t = lines[from].trim();
    if (t.length > 2 && t.endsWith("$$")) return from;
    let j = from + 1;
    while (j < n && !lines[j].includes("$$")) j++;
    return j;
  };
  const skipComment = (from: number): number => {
    let j = from;
    while (j < n && !lines[j].includes("-->")) j++;
    return j;
  };
  const headings = () => headingStack.map((h) => h.text);

  while (i < n) {
    const line = lines[i];
    const trimmed = line.trim();

    if (isBlank(line)) {
      prevBlank = true;
      i++;
      continue;
    }
    if (OCCLUSION_FENCE.test(line)) {
      const close = skipFence(i);
      const card = buildOcclusionCard(lines, i, close, headings());
      if (card) cards.push(card);
      i = (card ? card.endLine : close) + 1;
      prevBlank = false;
      continue;
    }
    if (FENCE.test(line)) {
      i = skipFence(i) + 1;
      prevBlank = false;
      continue;
    }
    if (trimmed.startsWith("$$")) {
      i = skipMath(i) + 1;
      prevBlank = false;
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      i = skipComment(i) + 1;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text: h[2] });
      headingLines.push(i);
      inList = false;
      prevBlank = true;
      i++;
      continue;
    }
    if (trimmed.startsWith(">")) {
      // Quotes and callouts hold no cards, except card callouts (`> [!card]`), whose inside is
      // parsed like a note of its own and mapped back to this note's lines (spec 0002 §3.2).
      let j = i;
      while (j < n && lines[j].trim().startsWith(">")) j++;
      const head = CALLOUT_HEAD.exec(line);
      if (head && CARD_CALLOUTS.has(head[1].toLowerCase()) && j > i + 1) {
        const prefix = QUOTE.exec(lines[i + 1])?.[1] ?? "> ";
        const inner = lines.slice(i + 1, j).map((l) => l.replace(QUOTE, ""));
        for (const c of parseNote(inner.join("\n"))) {
          const off = i + 1;
          cards.push({
            ...c,
            startLine: c.startLine + off,
            endLine: c.endLine + off,
            idLine: c.idLine + off,
            sourceLines: lines.slice(c.startLine + off, c.endLine + off + 1),
            quote: prefix,
            headings: headings(),
          });
        }
      }
      prevBlank = false;
      i = j;
      continue;
    }
    if (trimmed.startsWith("|")) {
      // Tables hold no cards (spec 0002 §3.2).
      prevBlank = false;
      i++;
      continue;
    }

    const li = LIST_ITEM.exec(line);
    if (li) {
      inList = true;
      const itemIndent = indentWidth(line);
      let end = i;
      let j = i + 1;
      while (j < n) {
        if (isBlank(lines[j])) {
          let k = j + 1;
          while (k < n && isBlank(lines[k])) k++;
          if (k < n && indentWidth(lines[k]) > itemIndent) {
            j = k;
            continue;
          }
          break;
        }
        if (indentWidth(lines[j]) > itemIndent) {
          if (FENCE.test(lines[j])) j = skipFence(j);
          end = j;
          j++;
          continue;
        }
        break;
      }
      const frontRaw = line.slice(li[0].length);
      const children = lines.slice(i + 1, end + 1).filter((l) => !isPureComment(l));
      const card = buildCard(frontRaw, children, lines, i, end, i, "list", headings());
      if (card) {
        cards.push(card);
        i = end + 1; // children belong to this card's back
      } else {
        i++; // a plain bullet; its children may be cards of their own
      }
      prevBlank = false;
      continue;
    }

    if (inList && (indentWidth(line) > 0 || !prevBlank)) {
      // Continuation text of a list item that isn't a card.
      prevBlank = false;
      i++;
      continue;
    }
    inList = false;

    // A paragraph: first line is the front; the lines under it, up to a blank line or the next
    // line that is a card of its own, are the back.
    if (!hasMarker(line)) {
      // Plain note text. The next line may still be a card, so move on one line at a time.
      prevBlank = false;
      i++;
      continue;
    }
    let end = i;
    let j = i + 1;
    let lastContent = i;
    while (j < n && !isBlank(lines[j]) && !HEADING.test(lines[j]) && !FENCE.test(lines[j])) {
      if (lines[j].trim().startsWith("$$")) break;
      if (hasMarker(lines[j])) break;
      end = j;
      if (!isPureComment(lines[j])) lastContent = j;
      j++;
    }
    const backLines = lines.slice(i + 1, end + 1).filter((l) => !isPureComment(l));
    const card = buildCard(line, backLines, lines, i, end, lastContent, "paragraph", headings());
    if (card) cards.push(card);
    prevBlank = false;
    i = end + 1;
  }
  fillSectionImages(lines, cards, headingLines);
  return cards;
}
