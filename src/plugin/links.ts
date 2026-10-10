/**
 * Linked notes (spec 0011): loads every `*.cardlinks.json` link table and the Anki import manifest,
 * and answers "which study note is this card about?" and "which cards belong to this note?".
 */
import { debounce, normalizePath, type TFile } from "obsidian";
import type { CardRef } from "../core/collection";
import { isLinkTable, LinkIndex, parseLinkTable, parseManifest, type LinkTable } from "../core/links";
import type FlashcardsPlugin from "../main";
import { findDataFiles, noteResolver } from "./vault-files";

export class LinkService {
  private index = new LinkIndex([], new Map());

  constructor(private plugin: FlashcardsPlugin) {}

  private get manifestPath(): string {
    return normalizePath(`${this.plugin.settings.stateFolder}/imports/anki.md`);
  }

  /** Whether a changed file feeds the links (the import manifest; tables aren't watched by Obsidian). */
  isSource(path: string): boolean {
    return isLinkTable(path) || path === this.manifestPath;
  }

  rebuildSoon = debounce(() => void this.rebuild(), 1500, true);

  async rebuild(): Promise<void> {
    const { vault } = this.plugin.app;
    const mfile = vault.getFileByPath(this.manifestPath);
    // Only cards that are loaded (hidden decks aren't; archived decks are gone): resolving links for
    // the rest cost ~2 s at every phone startup.
    const loaded = new Set(this.plugin.index.cardsWithIds().map((c) => c.id!));
    const manifest = new Map([...(mfile ? parseManifest(await vault.cachedRead(mfile)) : new Map<string, string[]>())].filter(([id]) => loaded.has(id)));
    const keys = new Set([...manifest.values()].flat());
    const tables: Array<{ path: string; table: LinkTable }> = [];
    if (keys.size) {
      for (const path of await findDataFiles(this.plugin.app, this.plugin.settings.stateFolder, isLinkTable)) {
        try {
          const table = parseLinkTable(await vault.adapter.read(path));
          const links = table.links.filter((l) => (l.guid && keys.has(l.guid)) || (l.ankihub_id && keys.has(l.ankihub_id)));
          if (links.length) tables.push({ path, table: { ...table, links } });
        } catch (e) {
          console.warn(`Flashcards: ${path} isn't a valid link table`, e);
        }
      }
    }
    const resolved = manifest.size
      ? tables.map(({ path, table }) => {
          const r = noteResolver(this.plugin.app, path);
          return { ...table, links: table.links.map((l) => ({ ...l, note: r(l.note) ?? "" })).filter((l) => l.note) };
        })
      : [];
    this.index = new LinkIndex(resolved, manifest);
    this.plugin.events.trigger("changed");
  }

  /** The study notes a card is linked to, best first. */
  notesFor(ref: CardRef): readonly string[] {
    return this.index.notesFor(ref.card.id);
  }

  /** IDs of the cards linked to a note. */
  cardsFor(path: string): readonly string[] {
    return this.index.cardsFor(path);
  }

  files(ref: CardRef): TFile[] {
    return this.notesFor(ref)
      .map((p) => this.plugin.app.vault.getFileByPath(p))
      .filter((f): f is TFile => !!f);
  }

  get size(): number {
    return this.index.size;
  }
}
