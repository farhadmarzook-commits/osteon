/** Keeps the parsed cards of every flashcard note up to date, incrementally. */
import { App, Events, getAllTags, TFile, type CachedMetadata } from "obsidian";
import { deckFor, inHiddenDeck, refsForNote, renamedDeck, type CardRef } from "../core/collection";
import { parseNote, type ParsedCard } from "../core/parser";
import type { FlashcardsSettings } from "./settings";

interface NoteEntry {
  path: string;
  deck: string;
  cards: ParsedCard[];
}

export class CardIndex extends Events {
  private notes = new Map<string, NoteEntry>();
  private refsCache: CardRef[] | null = null;
  /**
   * Hidden decks are not read unless this is on (Show Hidden Decks, an Anki import): on a big vault
   * they can hold most of the cards, and reading them is most of the startup time on a phone.
   */
  private withHidden = false;
  /** Paths the last build() read, to tell whether a rescan would change anything. */
  private scanned = new Set<string>();

  constructor(
    private app: App,
    private settings: () => FlashcardsSettings,
  ) {
    super();
  }

  private tagsOf(cache: CachedMetadata | null): string[] {
    return cache ? (getAllTags(cache) ?? []).map((t) => t.replace(/^#/, "")) : [];
  }

  shouldScan(file: TFile, cache: CachedMetadata | null): boolean {
    if (file.extension !== "md") return false;
    const s = this.settings();
    if (file.path.startsWith(s.stateFolder + "/")) return false;
    const tagged = this.tagsOf(cache).some((t) => /^flashcards(\/|$)/i.test(t));
    return tagged || s.cardFolders.some((f) => file.path.startsWith(f.replace(/\/+$/, "") + "/"));
  }

  async build(): Promise<void> {
    this.notes.clear();
    const files = this.toScan();
    this.scanned = new Set(files.map((f) => f.path));
    // Start every read at once (each waits on disk/iCloud on the phone), then parse in order.
    const texts = await Promise.all(files.map((f) => this.app.vault.cachedRead(f)));
    this.notes.clear(); // anything set by an edit event during the reads is re-read below
    for (const [i, file] of files.entries()) {
      this.setNote(file, texts[i], this.app.metadataCache.getFileCache(file));
    }
    this.changed();
    this.trigger("built"); // which cards are loaded may have changed (linked notes follow)
  }

  private toScan(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((file) => {
      const cache = this.app.metadataCache.getFileCache(file);
      return this.shouldScan(file, cache) && !this.skipHidden(file, cache);
    });
  }

  /**
   * Rebuild only if the set of card notes changed (on a fresh device tags can arrive after startup).
   * Otherwise a needless full rebuild froze the phone for seconds after the first answer.
   */
  async rescanIfChanged(): Promise<boolean> {
    const now = this.toScan();
    if (now.length === this.scanned.size && now.every((f) => this.scanned.has(f.path))) return false;
    await this.build();
    return true;
  }

  /** Read hidden decks too (or stop reading them); rebuilds only when that changes. */
  async setWithHidden(on: boolean): Promise<void> {
    if (this.withHidden === on) return;
    this.withHidden = on;
    await this.build();
  }

  get includesHidden(): boolean {
    return this.withHidden;
  }

  private deckOf(file: TFile, cache: CachedMetadata | null): string {
    return deckFor(file.path, this.tagsOf(cache), cache?.frontmatter?.["anki-deck"]);
  }

  /** The deck comes from the path, tags and frontmatter, so a hidden note is skipped without reading it. */
  private skipHidden(file: TFile, cache: CachedMetadata | null): boolean {
    if (this.withHidden) return false;
    const s = this.settings();
    return s.hiddenDecks.length > 0 && inHiddenDeck(renamedDeck(this.deckOf(file, cache), s.deckRenames), s.hiddenDecks);
  }

  private setNote(file: TFile, text: string, cache: CachedMetadata | null): void {
    const cards = this.skipHidden(file, cache) ? [] : parseNote(text);
    if (cards.length) {
      this.notes.set(file.path, { path: file.path, deck: this.deckOf(file, cache), cards });
    } else {
      this.notes.delete(file.path);
    }
  }

  /** metadataCache "changed" passes the file's new text, so no extra read is needed. */
  onMetadataChanged(file: TFile, text: string, cache: CachedMetadata): void {
    const had = this.notes.has(file.path);
    if (this.shouldScan(file, cache)) this.setNote(file, text, cache);
    else if (had) this.notes.delete(file.path);
    else return;
    this.changed();
  }

  /** Re-parse a note from text this plugin just wrote, before the metadata cache catches up. */
  updateFromText(file: TFile, text: string): void {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!this.shouldScan(file, cache) && !this.notes.has(file.path)) return;
    this.setNote(file, text, cache);
    this.changed();
  }

  onDelete(path: string): void {
    if (this.notes.delete(path)) this.changed();
  }

  async onRename(file: TFile, oldPath: string): Promise<void> {
    this.notes.delete(oldPath);
    const cache = this.app.metadataCache.getFileCache(file);
    if (this.shouldScan(file, cache)) this.setNote(file, await this.app.vault.cachedRead(file), cache);
    this.changed();
  }

  /** Deck names changed (a rename): rebuild the card list with the new names. */
  decksRenamed(): void {
    this.changed();
  }

  hasId(id: string): boolean {
    for (const n of this.notes.values()) if (n.cards.some((c) => c.id === id)) return true;
    return false;
  }

  /** Every card instance, in note order (notes sorted by path, as in the file explorer). */
  refs(): CardRef[] {
    if (this.refsCache) return this.refsCache;
    const out: CardRef[] = [];
    const renames = this.settings().deckRenames;
    const paths = [...this.notes.keys()].sort((a, b) => a.localeCompare(b));
    for (const p of paths) {
      const n = this.notes.get(p)!;
      out.push(...refsForNote(n.path, renamedDeck(n.deck, renames), n.cards, out.length));
    }
    this.refsCache = out;
    return out;
  }

  cardsWithIds(): ParsedCard[] {
    const out: ParsedCard[] = [];
    for (const n of this.notes.values()) for (const c of n.cards) if (c.id) out.push(c);
    return out;
  }

  /** IDs that appear on more than one card (e.g. a copy-pasted card), with their notes. */
  duplicateIds(): Map<string, string[]> {
    const where = new Map<string, string[]>();
    for (const n of this.notes.values()) {
      for (const c of n.cards) {
        if (!c.id) continue;
        where.set(c.id, [...(where.get(c.id) ?? []), n.path]);
      }
    }
    return new Map([...where].filter(([, paths]) => paths.length > 1));
  }

  private changed(): void {
    this.refsCache = null;
    this.trigger("changed");
  }
}
