/**
 * Anki's Add window (key A): pick a deck and a note, type a card, and it's appended to the
 * note. Stays open for the next card, as in Anki.
 */
import { App, Modal, normalizePath, Notice, Setting, TFile } from "obsidian";
import { deckFor, inDeck, renamedDeck } from "../../core/collection";
import { parseNote } from "../../core/parser";
import type FlashcardsPlugin from "../../main";

const LAST_NOTE_KEY = "flashcards-add-last-note";
const NEW_NOTE = "__new__";

export class AddCardModal extends Modal {
  private deck: string;
  private notePath = "";
  private newName = "";

  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    deck: string | null,
  ) {
    super(app);
    const decks = this.decks();
    this.deck = deck && decks.some((d) => d.toLowerCase() === deck.toLowerCase()) ? deck : decks[0] ?? "";
  }

  private decks(): string[] {
    return [...new Set(this.plugin.index.refs().map((r) => r.deck))].sort((a, b) => a.localeCompare(b));
  }

  private notesIn(deck: string): string[] {
    const paths = new Set<string>();
    for (const r of this.plugin.index.refs()) if (r.deck.toLowerCase() === deck.toLowerCase()) paths.add(r.path);
    // Sub-deck notes come after the deck's own notes.
    for (const r of this.plugin.index.refs()) if (inDeck(r.deck, deck)) paths.add(r.path);
    return [...paths];
  }

  onOpen(): void {
    this.setTitle("Add card");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const decks = this.decks();
    new Setting(contentEl).setName("Deck").addDropdown((d) => {
      for (const deck of decks) d.addOption(deck, deck.split("/").join(" › "));
      d.setValue(this.deck).onChange((v) => {
        this.deck = v;
        this.notePath = "";
        this.render();
      });
    });

    const notes = this.notesIn(this.deck);
    const last: unknown = this.app.loadLocalStorage(LAST_NOTE_KEY);
    if (!this.notePath) this.notePath = typeof last === "string" && notes.includes(last) ? last : notes[0] ?? NEW_NOTE;
    new Setting(contentEl).setName("Note").addDropdown((d) => {
      for (const p of notes) d.addOption(p, p.replace(/\.md$/, ""));
      d.addOption(NEW_NOTE, "New note…");
      d.setValue(this.notePath).onChange((v) => {
        this.notePath = v;
        this.render();
      });
    });
    if (this.notePath === NEW_NOTE) {
      new Setting(contentEl)
        .setName("New note name")
        .setDesc(`Created in ${this.folderFor(this.deck) || "the vault root"}, tagged #flashcards.`)
        .addText((t) => t.setValue(this.newName).onChange((v) => (this.newName = v.trim())));
    }

    const ta = contentEl.createEl("textarea", { cls: "fc-edit-area fc-add-area" });
    ta.rows = 6;
    ta.placeholder =
      "The ACL originates on the ==lateral femoral condyle==.\nExplanation on the lines below becomes the back.\n\n(or  Question :: Answer   ·   Term ::: Definition)";
    const add = async () => {
      const text = ta.value.trim();
      if (!text) return;
      if (!parseNote(text).length) {
        new Notice("That isn't a card yet: add a ==cloze==, or Question :: Answer.");
        return;
      }
      const ok = await this.append(text);
      if (ok) {
        ta.value = "";
        ta.focus();
      }
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void add();
      }
    });
    new Setting(contentEl)
      .setDesc("First line = front; lines under it = back. ⌘/Ctrl+Enter adds and keeps this window open.")
      .addButton((b) => b.setButtonText("Close").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Add").setCta().onClick(() => void add()));
    window.setTimeout(() => ta.focus(), 0);
  }

  /** The folder a deck's new notes go in: the deck's folder when decks come from folders. */
  private folderFor(deck: string): string {
    const first = this.notesIn(deck)[0];
    if (first) return first.includes("/") ? first.slice(0, first.lastIndexOf("/")) : "";
    return deck === "Default" ? "" : deck;
  }

  private async append(card: string): Promise<boolean> {
    const { vault } = this.app;
    let file: TFile | null;
    if (this.notePath === NEW_NOTE) {
      if (!this.newName) {
        new Notice("Give the new note a name.");
        return false;
      }
      const folder = this.folderFor(this.deck);
      const path = normalizePath(`${folder ? folder + "/" : ""}${this.newName.replace(/[\\/:*?"<>|]/g, "-")}.md`);
      if (vault.getAbstractFileByPath(path)) {
        new Notice("A note with that name already exists.");
        return false;
      }
      if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder).catch(() => undefined);
      // If the folder alone wouldn't put the note in this deck (tag-based decks, such as imported
      // Anki decks), give it the deck's tag.
      const byFolder = renamedDeck(deckFor(path, []), this.plugin.settings.deckRenames);
      const tag = !this.deck || byFolder.toLowerCase() === this.deck.toLowerCase() ? "flashcards" : `flashcards/${this.deck.replace(/\s+/g, "-")}`;
      file = await vault.create(path, `---\ntags: [${tag}]\n---\n\n${card}\n`);
      this.notePath = file.path;
    } else {
      file = vault.getFileByPath(this.notePath);
      if (!file) {
        new Notice("That note no longer exists.");
        return false;
      }
      await vault.process(file, (text) => `${text.replace(/\s*$/, "")}\n\n${card}\n`);
    }
    this.app.saveLocalStorage(LAST_NOTE_KEY, file.path);
    new Notice(`Added to ${file.basename}.`);
    this.render();
    return true;
  }
}
