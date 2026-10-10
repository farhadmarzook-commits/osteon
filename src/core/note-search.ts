/**
 * The note picker's own search (Link a note to this card), used when the Omnisearch plugin is not
 * installed. Every word typed must start a word, or sit inside one, in the note's title, an alias or
 * a heading, in any order: "plateau tib" finds "Tibial Plateau Fracture", and "schatzker" finds the
 * note with a "## Schatzker" heading. Titles count for most, headings for least.
 */
export interface SearchableNote {
  path: string;
  /** The note's title and aliases, title first. */
  names: string[];
  headings: string[];
}

export interface NoteHit {
  path: string;
  /** The heading that matched, when the title and aliases alone did not cover the query. */
  heading?: string;
}

const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** 2 = a word starts with it, 1 = a word contains it, 0 = absent. */
function hit(inWords: string[], q: string): number {
  let best = 0;
  for (const w of inWords) {
    if (w.startsWith(q)) return 2;
    if (q.length >= 3 && w.includes(q)) best = 1;
  }
  return best;
}

export function searchNotes(query: string, notes: SearchableNote[], max = 20): NoteHit[] {
  const qs = words(query);
  if (!qs.length) return [];
  const scored: Array<NoteHit & { score: number; len: number }> = [];
  for (const n of notes) {
    const title = words(n.names[0] ?? "");
    const aliases = n.names.slice(1).map(words);
    const heads = n.headings.map(words);
    let score = 0;
    let heading: string | undefined;
    let ok = true;
    for (const q of qs) {
      const t = hit(title, q);
      const a = Math.max(0, ...aliases.map((x) => hit(x, q)));
      if (t || a) {
        score += Math.max(t * 3, a * 2.5);
        continue;
      }
      let h = 0;
      heads.forEach((x, i) => {
        const v = hit(x, q);
        if (v > h) {
          h = v;
          heading ??= n.headings[i];
        }
      });
      if (!h) {
        ok = false;
        break;
      }
      score += h;
    }
    if (ok) scored.push({ path: n.path, heading, score, len: title.length });
  }
  scored.sort((x, y) => y.score - x.score || x.len - y.len || x.path.localeCompare(y.path));
  return scored.slice(0, max).map(({ path, heading }) => ({ path, heading }));
}

/**
 * One readable line out of a search engine's excerpt (lines joined by <br>): the first line of the
 * note's text that holds one of the words found, without properties, tags or Markdown marks.
 */
export function excerptLine(excerpt: string, found: string[], max = 140): string {
  const lines = excerpt
    .split(/<br\s*\/?>|\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== "---" && !/^-\s+[\w/-]+$/.test(l) && !/^[\w-]+:\s*\S*$/.test(l) && !/^\|?[\s:|-]+\|?$/.test(l));
  const clean = (l: string) =>
    l
      .replace(/!\[\[[^\]]*\]\]/g, "")
      .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/&(gt|lt|amp|quot|#39|nbsp);/g, (_, e: string) => ({ gt: ">", lt: "<", amp: "&", quot: '"', "#39": "'", nbsp: " " })[e] ?? "")
      .replace(/[*_`=#>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const low = found.map((f) => f.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")).filter((f) => f.length > 2);
  const cleaned = lines.map(clean).filter(Boolean);
  const line = cleaned.find((l) => low.some((f) => l.toLowerCase().includes(f))) ?? cleaned[0] ?? "";
  return line.length > max ? line.slice(0, max - 1).trimEnd() + "…" : line;
}
