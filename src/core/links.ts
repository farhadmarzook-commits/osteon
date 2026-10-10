/**
 * Linked notes (spec 0011): a link table maps imported Anki notes (by GUID, or AnkiHub ID) to the
 * study note that teaches them, so N opens "the note about this card" and `note:` finds a note's
 * cards even when they live in an imported deck file. Pure and tested.
 */

export interface LinkRow {
  guid: string;
  ankihub_id?: string | null;
  note: string;
}

export interface LinkTable {
  version: number;
  deck?: string;
  links: LinkRow[];
}

/** File names that are link tables: `<anything>.cardlinks.json`. */
export const LINK_TABLE_SUFFIX = ".cardlinks.json";

export function isLinkTable(path: string): boolean {
  return path.toLowerCase().endsWith(LINK_TABLE_SUFFIX);
}

/** Parse a link table, dropping malformed rows. Throws on a file that isn't one. */
export function parseLinkTable(json: string): LinkTable {
  const raw = JSON.parse(json) as Partial<LinkTable>;
  if (!raw || !Array.isArray(raw.links)) throw new Error("not a link table (no links array)");
  const links = raw.links.filter(
    (r): r is LinkRow => !!r && typeof r.guid === "string" && typeof r.note === "string" && r.guid !== "" && r.note !== "",
  );
  return { version: Number(raw.version) || 1, deck: raw.deck, links };
}

/**
 * The import manifest (`Flashcards/imports/anki.md`): one `guid<TAB>fc-<id>` line per imported
 * Anki note, plus an optional third column with the AnkiHub note ID. Returns card ID → keys.
 */
export function parseManifest(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 2) continue;
    const id = cols[1].trim().replace(/^fc-/, "");
    if (!id) continue;
    out.set(id, cols.filter((c, i) => i !== 1 && c.trim()).map((c) => c.trim()));
  }
  return out;
}

/** Card ID ↔ linked note paths, built from the manifest and every link table. */
export class LinkIndex {
  private byKey = new Map<string, string[]>();
  private byId = new Map<string, string[]>();
  private byNote = new Map<string, string[]>();

  /**
   * `resolve` turns a table's note path into the note's current vault path (or null if it's gone),
   * so tables survive notes being moved or the vault being nested in another folder.
   */
  constructor(tables: LinkTable[], manifest: Map<string, string[]>, resolve: (note: string) => string | null = (n) => n) {
    const cache = new Map<string, string | null>();
    const res = (n: string) => {
      if (!cache.has(n)) cache.set(n, resolve(n));
      return cache.get(n)!;
    };
    for (const t of tables) {
      for (const r of t.links) {
        const path = res(r.note);
        if (!path) continue;
        for (const k of [r.guid, r.ankihub_id]) if (k) push(this.byKey, k, path);
      }
    }
    for (const [id, keys] of manifest) {
      const notes = [...new Set(keys.flatMap((k) => this.byKey.get(k) ?? []))];
      if (!notes.length) continue;
      this.byId.set(id, notes);
      for (const n of notes) push(this.byNote, n, id);
    }
  }

  /** The study notes linked to a card, best first. */
  notesFor(cardId: string | undefined): readonly string[] {
    return (cardId && this.byId.get(cardId)) || [];
  }

  /** IDs of the cards linked to a note. */
  cardsFor(notePath: string): readonly string[] {
    return this.byNote.get(notePath) ?? [];
  }

  get size(): number {
    return this.byId.size;
  }
}

function push(m: Map<string, string[]>, k: string, v: string): void {
  const a = m.get(k);
  if (!a) m.set(k, [v]);
  else if (!a.includes(v)) a.push(v);
}
