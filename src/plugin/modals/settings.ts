/** Osteon's settings in a window of their own, opened from the Decks page (no trip through Settings → Osteon). */
import { App, Modal } from "obsidian";
import type FlashcardsPlugin from "../../main";
import { FlashcardsSettingTab } from "../settings";

export class SettingsModal extends Modal {
  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Osteon settings");
    this.modalEl.addClass("fc-settings-modal");
    new FlashcardsSettingTab(this.app, this.plugin).drawInto(this.contentEl);
  }

  onClose(): void {
    this.plugin.saveSettingsSoon.run();
    this.contentEl.empty();
  }
}
