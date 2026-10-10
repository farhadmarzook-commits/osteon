/**
 * The medical-term hover's dictionary and matcher (spec 0005 §2). Pure: no Obsidian imports.
 *
 * Sources, first match wins: his notes (titles/aliases), his "My terms" list, MeSH, AI.
 */
import { BASIC_MEDICAL_WORDS } from "./data/basic-medical";
import { COMMON_WORDS } from "./data/common-words";
import { imageEmbeds } from "./parser";

export type TermSource = "note" | "list" | "mesh" | "ai";

export interface TermEntry {
  /** The name shown in the popup. */
  term: string;
  /** Every surface form that should match (including `term`). */
  variants: string[];
  /** Definition text; for "note" entries it is read from the note when the popup opens. */
  definition: string;
  source: TermSource;
  notePath?: string;
}

export interface TermMatch {
  start: number;
  end: number;
  entry: TermEntry;
}

/**
 * "strict" (default): hard terms only, like AMBOSS: no everyday or basic medical single words,
 * no single words under 7 letters. "uncommon": skips everyday English words. "all": everything.
 */
export type Sensitivity = "strict" | "all" | "uncommon" | "off";

let basic: Set<string> | null = null;
/** Basic medical words (and their singular forms) that "Hard terms only" never underlines. */
export function basicMedicalWords(): Set<string> {
  if (!basic) basic = new Set(BASIC_MEDICAL_WORDS.split(/\s+/).filter(Boolean).flatMap((w) => [w, stem(w)]));
  return basic;
}

let common: Set<string> | null = null;
export function commonWords(): Set<string> {
  if (!common) common = new Set(COMMON_WORDS.split(" "));
  return common;
}

/** Plural-insensitive token form: "fractures" → "fracture", "arteries" → "artery". */
export function stem(tok: string): string {
  if (tok.length <= 3) return tok;
  if (tok.endsWith("ies")) return tok.slice(0, -3) + "y";
  if (/(ss|us|is|ous)$/.test(tok)) return tok;
  if (/(xes|ches|shes|sses)$/.test(tok)) return tok.slice(0, -2);
  if (tok.endsWith("s")) return tok.slice(0, -1);
  return tok;
}

const TOKEN = /[A-Za-z0-9\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F'’]*/g;
const ALL_CAPS = /^(?=.*[A-Z])[A-Z0-9]{2,}$/;

function normTok(raw: string): string {
  const plain = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Abbreviations aren't plurals: "AIDS" must not become "aid".
  if (ALL_CAPS.test(plain)) return plain.toLowerCase();
  return stem(plain.toLowerCase().replace(/['’]s$/, "").replace(/['’]/g, ""));
}

export function termTokens(s: string): string[] {
  return (s.match(TOKEN) ?? []).map(normTok).filter(Boolean);
}

interface Candidate {
  tokens: string[];
  entry: TermEntry;
  /** For all-caps abbreviations ("PIN", "AIN"): the exact tokens to match, case-sensitively. */
  exact?: string[];
}

export interface Dictionary {
  index: Map<string, Candidate[]>;
  size: number;
}

export interface BuildOptions {
  sensitivity: Sensitivity;
  /** Normalised forms (termTokens(...).join(" ")) never to underline. */
  hidden: Set<string>;
}

function exactAbbrev(v: string): boolean {
  return /^[A-Z0-9]{2,}$/.test(v);
}

/** Sources must be passed in precedence order (notes, list, MeSH, AI). */
export function buildDictionary(entries: TermEntry[], o: BuildOptions): Dictionary {
  const index = new Map<string, Candidate[]>();
  const seen = new Set<string>();
  const cw = commonWords();
  let size = 0;
  if (o.sensitivity === "off") return { index, size };
  for (const entry of entries) {
    for (const v of entry.variants) {
      const tokens = termTokens(v);
      if (!tokens.length) continue;
      const key = tokens.join(" ");
      if (seen.has(key) || o.hidden.has(key)) continue;
      // Single short or everyday words are noise, except in his own list.
      if (entry.source !== "list" && tokens.length === 1) {
        const raw = v.toLowerCase();
        if (tokens[0].length < 3 && !/^[A-Z]{2,}$/.test(v)) continue;
        // All-caps abbreviations (AIDS, PIN) only match in capitals, so the everyday word doesn't count.
        if ((o.sensitivity === "uncommon" || o.sensitivity === "strict") && !exactAbbrev(v) && (cw.has(raw) || cw.has(tokens[0]))) continue;
        // Hard terms only: dictionary words (not his notes or AI finds) must be long and not basic.
        if (o.sensitivity === "strict" && entry.source === "mesh" && !exactAbbrev(v)) {
          const bm = basicMedicalWords();
          if (bm.has(raw) || bm.has(tokens[0]) || raw.replace(/[^a-z]/g, "").length < 7) continue;
        }
      }
      // Hard terms only: a multi-word dictionary term made only of everyday/basic words is skipped.
      if (o.sensitivity === "strict" && entry.source === "mesh" && tokens.length > 1) {
        const bm = basicMedicalWords();
        if (tokens.every((t) => cw.has(t) || bm.has(t))) continue;
      }
      seen.add(key);
      const bucket = index.get(tokens[0]) ?? [];
      const raw = v.match(TOKEN) ?? [];
      const exact = raw.some((t) => ALL_CAPS.test(t)) ? raw : undefined;
      bucket.push({ tokens, entry, exact });
      index.set(tokens[0], bucket);
      size++;
    }
  }
  for (const b of index.values()) b.sort((a, b2) => b2.tokens.length - a.tokens.length);
  return { index, size };
}

/**
 * Find terms in plain text: longest match first, each term only at its first occurrence.
 * `dicts` are layers in precedence order (e.g. notes+list, MeSH, AI): at equal length the
 * earlier layer wins, so the big MeSH layer can be built once and reused.
 */
export function findTerms(text: string, dicts: Dictionary | Dictionary[], already: Set<TermEntry> = new Set()): TermMatch[] {
  const layers = Array.isArray(dicts) ? dicts : [dicts];
  const toks: Array<{ norm: string; raw: string; start: number; end: number }> = [];
  for (const m of text.matchAll(TOKEN)) {
    toks.push({ norm: normTok(m[0]), raw: m[0].replace(/['’]s$/, ""), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  const out: TermMatch[] = [];
  let i = 0;
  while (i < toks.length) {
    let best: Candidate | null = null;
    for (const d of layers) {
      const bucket = d.index.get(toks[i].norm);
      if (!bucket) continue;
      for (const cand of bucket) {
        const n = cand.tokens.length;
        if (best && n <= best.tokens.length) break; // buckets are longest-first
        if (i + n > toks.length) continue;
        let ok = true;
        for (let k = 0; k < n; k++) {
          if (toks[i + k].norm !== cand.tokens[k] || (cand.exact && toks[i + k].raw !== cand.exact[k])) {
            ok = false;
            break;
          }
        }
        if (ok) {
          best = cand;
          break;
        }
      }
    }
    if (best) {
      const n = best.tokens.length;
      if (!already.has(best.entry)) {
        already.add(best.entry);
        out.push({ start: toks[i].start, end: toks[i + n - 1].end, entry: best.entry });
      }
      i += n;
    } else {
      i++;
    }
  }
  return out;
}

// ---- his "My terms" note ----------------------------------------------------------------

export interface MyTerms {
  defs: Array<{ term: string; aliases: string[]; definition: string }>;
  hidden: string[];
}

/**
 * ## Define
 * - Resident's ridge: Lateral intercondylar ridge; ...
 * - AIN (anterior interosseous nerve): Median nerve branch — FPL, FDP 2–3, PQ.
 * ## Never underline
 * - Fracture
 */
export function parseMyTerms(text: string): MyTerms {
  const out: MyTerms = { defs: [], hidden: [] };
  let section: "define" | "hide" | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      const t = h[1].toLowerCase();
      section = t.includes("never") || t.includes("hide") ? "hide" : t.includes("define") ? "define" : null;
      continue;
    }
    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (!item || !section) continue;
    if (section === "hide") {
      if (item[1].trim()) out.hidden.push(item[1].trim());
      continue;
    }
    const colon = item[1].indexOf(":");
    if (colon <= 0) continue;
    const head = item[1].slice(0, colon).trim();
    const definition = item[1].slice(colon + 1).trim();
    const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(head);
    const term = (m ? m[1] : head).trim();
    const aliases = m ? m[2].split(/[,;]/).map((x) => x.trim()).filter(Boolean) : [];
    if (term && definition) out.defs.push({ term, aliases, definition });
  }
  return out;
}

export const MY_TERMS_TEMPLATE = `# My terms

Definitions here win over MeSH and AI. Format: \`- Term (optional aliases): definition\`.

## Define
- Resident's ridge: Lateral intercondylar ridge; the ACL femoral footprint lies behind it.

## Never underline
- Fracture
`;

// ---- definitions from his notes ------------------------------------------------------------

/** The first real paragraph of a note (for the popup), as plain-ish text, and its first images. */
export function noteSummary(text: string, maxChars = 360): { definition: string; images: string[] } {
  const lines = text.split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i].trim() !== "---") i++;
    i++;
  }
  const para: string[] = [];
  let inFence = false;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^(`{3,}|~{3,})/.test(l)) {
      inFence = !inFence;
      if (para.length) break;
      continue;
    }
    if (inFence) continue;
    if (!l) {
      if (para.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(l) || /^>\s*\[!/.test(l) || /^!\[/.test(l) || /^#[\w/-]+$/.test(l) || /^\|/.test(l)) {
      if (para.length) break;
      continue;
    }
    para.push(l.replace(/^[-*+]\s+/, "").replace(/^>\s?/, ""));
  }
  let definition = para
    .join(" ")
    .replace(/\s\^[\w-]+$/, "")
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/==|\*\*|__|`/g, "")
    .replace(/<!--.*?-->/g, "")
    .trim();
  if (definition.length > maxChars) definition = definition.slice(0, maxChars).replace(/\s+\S*$/, "") + "…";
  return { definition, images: imageEmbeds(text).slice(0, 2) };
}

// ---- AI glossary files (one per device, append-only, like the review log) --------------------

export interface AiGlossary {
  terms: Array<{ term: string; definition: string }>;
  /** Hashes of cards already looked at. */
  cards: Set<string>;
}

export function formatAiTerm(term: string, definition: string, model: string, date: string): string {
  const clean = (s: string) => s.replace(/[\t\n\r]+/g, " ").trim();
  return ["term", clean(term), clean(definition), model, date].join("\t");
}

export function formatAiCard(hash: string): string {
  return `card\t${hash}`;
}

export function parseAiGlossary(texts: string[]): AiGlossary {
  const out: AiGlossary = { terms: [], cards: new Set() };
  const seen = new Set<string>();
  for (const text of texts) {
    for (const line of text.split("\n")) {
      const f = line.split("\t");
      if (f[0] === "card" && f[1]) out.cards.add(f[1].trim());
      else if (f[0] === "term" && f[1] && f[2]) {
        const key = termTokens(f[1]).join(" ");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.terms.push({ term: f[1], definition: f[2] });
      }
    }
  }
  return out;
}

// ---- MeSH (NLM's ASCII descriptor file, d<year>.bin) ----------------------------------------

/** Tree branches kept (spec 0005 §2.3): anatomy, diseases, drugs, techniques, psychiatry, phenomena. */
export const MESH_BRANCHES = ["A", "C", "D", "E", "F03", "G"];

export type MeshRecord = [term: string, synonyms: string[], definition: string];

function uninvert(t: string): string | null {
  const m = /^([^,]+),\s*([^,]+)$/.exec(t);
  return m ? `${m[2]} ${m[1]}` : null;
}

/**
 * Parse NLM's ASCII MeSH descriptors:
 *   *NEWRECORD / MH = heading / ENTRY = synonym|attrs... / MN = tree number / MS = scope note
 */
export function parseMeshAscii(text: string, branches = MESH_BRANCHES): MeshRecord[] {
  const out: MeshRecord[] = [];
  let mh = "";
  let ms = "";
  let entries: string[] = [];
  let trees: string[] = [];
  const flush = () => {
    if (mh && trees.some((t) => branches.some((b) => t === b || t.startsWith(b)))) {
      const forms = new Set<string>();
      for (const e of [mh, ...entries]) {
        forms.add(e);
        const u = uninvert(e);
        if (u) forms.add(u);
      }
      forms.delete(mh);
      const display = uninvert(mh) ?? mh;
      const syns = [...forms].filter((s) => s !== display && s.split(/\s+/).length <= 6).slice(0, 12);
      if (display !== mh) syns.unshift(mh);
      out.push([display, syns, ms]);
    }
    mh = "";
    ms = "";
    entries = [];
    trees = [];
  };
  // An indexOf loop rather than split("\n"): the file is ~30 MB, and 1.5M line strings at once
  // is a lot of memory on an iPhone.
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = text.length;
    const line = text.slice(pos, text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl);
    pos = nl + 1;
    if (line === "*NEWRECORD") {
      flush();
      continue;
    }
    const eq = line.indexOf(" = ");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const val = line.slice(eq + 3);
    if (key === "MH") mh = val.trim();
    else if (key === "MS") ms = val.trim();
    else if (key === "MN") trees.push(val.trim());
    else if (key === "ENTRY" || key === "PRINT ENTRY") {
      const t = val.split("|")[0].trim();
      if (t) entries.push(t);
    }
  }
  flush();
  return out;
}

export function meshEntries(records: MeshRecord[]): TermEntry[] {
  return records
    .filter((r) => r[2])
    .map(([term, syns, def]) => ({ term, variants: [term, ...syns], definition: def, source: "mesh" as const }));
}
