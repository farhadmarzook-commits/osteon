/**
 * Find a student's notes about a card when no note title appears in it word for word: an imported
 * card about an "acetabular fracture" should still find the note "Pelvic Ring and Acetabular
 * Fracture". Titles are compared by word stems, and a word counts for more the fewer titles use it,
 * so "fracture" (in dozens of titles) cannot make a match on its own but "acetabular" can.
 */
import { COMMON_WORDS } from "./data/common-words";

let common: Set<string> | null = null;

/** Direction and filler words that say nothing about a note's topic. */
const VAGUE = new Set(["anteri", "poster", "medial", "latera", "proxim", "distal", "superi", "inferi", "common", "associ", "genera", "disord", "diseas", "syndro"]);

/**
 * Distinct stems of the meaningful words in a text: the word without a plural ending, cut to 8
 * letters, so "acetabular" meets "acetabulum" but "isolated" does not meet "isolation precautions".
 */
export function stems(text: string): Set<string> {
  common ??= new Set(COMMON_WORDS.split(" ").slice(0, 3000));
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []) {
    const word = w.replace(/[^a-z]/g, "");
    if (word.length < 5 || common.has(word)) continue;
    if (VAGUE.has(word.slice(0, 6))) continue;
    out.add(word.replace(/(?:es|s)$/, (m) => (word.length - m.length >= 5 ? "" : m)).slice(0, 8));
  }
  return out;
}

export interface TitledNote {
  path: string;
  /** The note's title and aliases. */
  names: string[];
}

/**
 * The notes whose titles share distinctive words with a text, best first. A note needs at least one
 * shared stem that at most `rareMax` titles use, and at least two thirds of the words of its title (or
 * of one alias) must be shared. Built once for a set of notes; `match` is then cheap.
 */
export class NoteMatcher {
  private titleStems: Array<Set<string>>;
  private nameStems: Array<Array<Set<string>>>;
  private df = new Map<string, number>();

  constructor(
    private notes: TitledNote[],
    private rareMax = 6,
  ) {
    this.nameStems = notes.map((n) => n.names.map((name) => stems(name)));
    this.titleStems = this.nameStems.map((sets) => new Set(sets.flatMap((x) => [...x])));
    for (const s of this.titleStems) for (const x of s) this.df.set(x, (this.df.get(x) ?? 0) + 1);
  }

  match(text: string, max = 3): string[] {
    const inText = stems(text);
    if (!inText.size) return [];
    const scored: Array<{ path: string; score: number }> = [];
    this.notes.forEach((n, i) => {
      let score = 0;
      let rare = false;
      for (const x of this.titleStems[i]) {
        if (!inText.has(x)) continue;
        const count = this.df.get(x) ?? 1;
        score += 1 / count;
        if (count <= this.rareMax) rare = true;
      }
      if (!rare) return;
      // Two thirds of the words of the title, or of any one alias (aliases must not dilute the title).
      const half = this.nameStems[i].some((own) => {
        let hit = 0;
        for (const x of own) if (inText.has(x)) hit++;
        return own.size > 0 && hit * 3 >= own.size * 2;
      });
      if (half) scored.push({ path: n.path, score });
    });
    return scored
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, max)
      .map((x) => x.path);
  }
}

export function matchNotes(text: string, notes: TitledNote[], max = 3, rareMax = 6): string[] {
  return new NoteMatcher(notes, rareMax).match(text, max);
}
