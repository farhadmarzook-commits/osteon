/** Anki's Rename deck dialog: the full name with `::` between sub-decks, editable in place. */
import { App, Modal, Notice, Setting } from "obsidian";
import { cleanDeckName, inDeck } from "../../core/collection";
import type FlashcardsPlugin from "../../main";

export class RenameDeckModal extends Modal {
  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    private deck: string,
    private onDone: (from: string, to: string) => void = () => undefined,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Rename deck");
    let value = this.deck.split("/").join("::");
    const submit = async () => {
      const to = cleanDeckName(value);
      if (!to) {
        new Notice("Type a deck name.");
        return;
      }
      if (to === this.deck) {
        this.close();
        return;
      }
      if (to.toLowerCase() !== this.deck.toLowerCase() && inDeck(to, this.deck)) {
        new Notice("A deck can't be moved inside itself.");
        return;
      }
      await this.plugin.renameDeck(this.deck, to);
      this.onDone(this.deck, to);
      this.close();
    };
    new Setting(contentEl)
      .setName("New deck name")
      .setDesc("Use :: to make it a sub-deck (Parent::Child). Your notes are not changed.")
      .addText((t) => {
        t.setValue(value).onChange((v) => (value = v));
        t.inputEl.style.width = "100%";
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        });
        window.setTimeout(() => t.inputEl.select(), 0);
      });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("OK").setCta().onClick(() => void submit()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
