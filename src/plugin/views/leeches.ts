/** Leeches: cards forgotten again and again, each with a way out (rewrite, crowns, retry, drop). */
import { Component, ItemView, MarkdownRenderer, Notice, type WorkspaceLeaf } from "obsidian";
import { cardFaces } from "../../core/faces";
import { findLeeches } from "../../core/leeches";
import type { QueueItem } from "../../core/queue";
import type FlashcardsPlugin from "../../main";
import { EditCardModal } from "../modals/card";
import { renderWhenVisible } from "./lazy-render";

export const VIEW_LEECHES = "flashcards-leeches";

export class LeechesView extends ItemView {
  private component?: Component;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: FlashcardsPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_LEECHES;
  }

  getDisplayText(): string {
    return "Leeches";
  }

  getIcon(): string {
    return "bug";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.plugin.events.on("changed", renderWhenVisible(this, () => this.render())));
    this.render();
  }

  async onClose(): Promise<void> {
    this.component?.unload();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("fc-leeches");
    this.component?.unload();
    this.component = new Component();
    this.component.load();
    if (!this.plugin.ready) {
      el.createDiv({ cls: "fc-muted", text: "Loading cards…" });
      return;
    }
    const leeches = this.plugin.leeches();
    el.createEl("h3", { text: `Leeches (${leeches.length})` });
    el.createEl("p", {
      cls: "fc-muted",
      text: "Cards you keep forgetting (lapses at or past the deck's leech threshold). A card usually leeches because it asks too much at once: rewrite it, reveal its answers one by one, or drop it.",
    });
    if (!leeches.length) {
      el.createDiv({ cls: "fc-muted", text: "No leeches right now." });
      return;
    }
    for (const item of leeches) this.row(el, item);
  }

  private row(parent: HTMLElement, item: QueueItem): void {
    const { ref, state } = item;
    const box = parent.createDiv({ cls: "fc-leech" });
    const meta = box.createDiv({ cls: "fc-leech-meta fc-muted" });
    meta.setText(
      [ref.deck.split("/").join(" › "), `${state?.card.lapses ?? 0} lapses`, state?.suspended ? "suspended" : "", state?.marked ? "★ marked" : ""]
        .filter(Boolean)
        .join(" · "),
    );
    const faces = cardFaces(ref.card, ref.slot, this.plugin.crownSplitFor(ref));
    const md = (text: string, cls: string) =>
      void MarkdownRenderer.render(this.app, text, box.createDiv({ cls: `markdown-rendered ${cls}` }), ref.path, this.component!);
    md(faces.kind === "basic" ? `${faces.question}\n\n---\n\n${faces.answer}` : faces.answer, "fc-leech-card");
    const bar = box.createDiv({ cls: "fc-leech-actions" });
    const btn = (text: string, title: string, fn: () => Promise<void> | void, cta = false) => {
      const b = bar.createEl("button", { text, cls: cta ? "mod-cta" : "", attr: { "aria-label": title } });
      b.onclick = () => void fn();
    };
    btn("Rewrite", "Edit the card, then put it back into reviews", () => {
      new EditCardModal(this.app, this.plugin, ref, () => void this.plugin.resolveLeech(item, "retry", "Rewritten and back in reviews.")).open();
    }, true);
    if (ref.card.type === "cloze" && !this.plugin.isCrowned(ref)) {
      btn("🦴 Reveal one by one", "Reveal the answers one at a time, then put it back into reviews", async () => {
        await this.plugin.setCrowns([ref], true);
        await this.plugin.resolveLeech(item, "retry", "Its answers now reveal one by one. Back in reviews.");
      });
    }
    btn("Try again", "Unsuspend it as it is", () => this.plugin.resolveLeech(item, "retry", "Back in reviews."));
    btn("Drop", "Keep it suspended and off this list", () => this.plugin.resolveLeech(item, "drop", "Dropped (suspended)."));
    btn("Open note", "Open the card's note", () => {
      const file = this.app.vault.getFileByPath(ref.path);
      if (file) void this.app.workspace.getLeaf("tab").openFile(file, { eState: { line: ref.card.startLine } });
      else new Notice("Note not found.");
    });
  }
}
