/**
 * Weak spots: the cards missed most (today, or over a week or a month) and the miss rate by topic,
 * each card with a way to learn it: its note, an explanation, a rewrite. Opened from the deck list,
 * never in the middle of a review.
 */
import { Component, ItemView, MarkdownRenderer, Notice, type WorkspaceLeaf } from "obsidian";
import { dayStart } from "../../core/day";
import { cardFaces } from "../../core/faces";
import type { FilteredDeck } from "../../core/filtered";
import { missesSince } from "../../core/queue";
import { topicOf, topicStats, weakCards, type WeakCard } from "../../core/weak";
import type FlashcardsPlugin from "../../main";
import { EditCardModal } from "../modals/card";
import { renderWhenVisible } from "./lazy-render";

export const VIEW_WEAK = "flashcards-weak";

const RANGES = [
  { id: "today", label: "Today", days: 0, minMisses: 2 },
  { id: "week", label: "7 days", days: 7, minMisses: 3 },
  { id: "month", label: "30 days", days: 30, minMisses: 4 },
] as const;
const PAGE = 20;

export class WeakView extends ItemView {
  private component?: Component;
  private range: (typeof RANGES)[number]["id"] = "today";
  private topic: string | null = null;
  private shown = PAGE;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: FlashcardsPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_WEAK;
  }

  getDisplayText(): string {
    return "Weak spots";
  }

  getIcon(): string {
    return "crosshair";
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
    el.addClass("fc-leeches", "fc-weak");
    this.component?.unload();
    this.component = new Component();
    this.component.load();
    const { plugin } = this;
    if (!plugin.ready) {
      el.createDiv({ cls: "fc-muted", text: "Loading cards…" });
      return;
    }
    const range = RANGES.find((r) => r.id === this.range)!;
    const today = dayStart(Date.now(), plugin.settings.dayStartHour);
    const since = today - range.days * 86400000;
    const items = plugin.studyItems(null);

    const head = el.createDiv({ cls: "fc-weak-head" });
    head.createEl("h3", { text: "Weak spots" });
    const tabs = head.createDiv({ cls: "fc-weak-tabs" });
    for (const r of RANGES) {
      const b = tabs.createEl("button", { text: r.label, cls: r.id === this.range ? "mod-cta" : "" });
      b.onclick = () => {
        this.range = r.id;
        this.topic = null;
        this.shown = PAGE;
        this.render();
      };
    }
    tabs.createEl("button", { text: "Decks" }).onclick = () => plugin.openDecks();

    // Topics, worst first. Clicking one narrows the cards below to it.
    const topics = topicStats(items, since, range.days ? 10 : 3);
    if (topics.length) {
      el.createEl("h4", { text: "By topic" });
      const table = el.createEl("table", { cls: "fc-weak-topics" });
      const hr = table.createEl("tr");
      for (const h of ["Topic", "Answers", "Missed", "Miss rate"]) hr.createEl("th", { text: h });
      for (const t of topics.slice(0, 15)) {
        const tr = table.createEl("tr", { cls: this.topic === t.topic ? "is-active" : "" });
        const a = tr.createEl("td").createEl("a", { text: t.topic, href: "#" });
        a.onclick = (e) => {
          e.preventDefault();
          this.topic = this.topic === t.topic ? null : t.topic;
          this.shown = PAGE;
          this.render();
        };
        tr.createEl("td", { text: String(t.answers), cls: "fc-num" });
        tr.createEl("td", { text: String(t.misses), cls: "fc-num" });
        const cell = tr.createEl("td", { cls: "fc-weak-rate" });
        cell.createDiv({ cls: "fc-weak-bar" }).style.width = `${Math.round(t.rate * 100)}%`;
        cell.createSpan({ text: `${Math.round(t.rate * 100)}%` });
      }
    }

    let weak = weakCards(items, since, range.minMisses);
    if (this.topic) weak = weak.filter((w) => topicOf(w.item.ref) === this.topic);
    const what = range.days ? `in the last ${range.days} days` : "today";
    el.createEl("h4", { text: `Cards missed ${range.minMisses}+ times ${what}${this.topic ? ` · ${this.topic}` : ""} (${weak.length})` });
    if (!weak.length) {
      el.createDiv({ cls: "fc-muted", text: range.days ? "None." : "None today. Cards you miss twice or more in a day show up here." });
      return;
    }
    const bar = el.createDiv({ cls: "fc-leech-actions" });
    const again = bar.createEl("button", { text: `Go through these ${weak.length} again`, cls: "mod-cta" });
    again.setAttr("aria-label", "A practice run: answers are not recorded, so it can't hurt their schedule");
    again.onclick = () => void this.practice(weak);
    for (const w of weak.slice(0, this.shown)) this.row(el, w, today);
    if (weak.length > this.shown) {
      const more = el.createEl("button", { text: `Show ${Math.min(PAGE, weak.length - this.shown)} more` });
      more.onclick = () => {
        this.shown += PAGE;
        this.render();
      };
    }
  }

  /** A preview deck of exactly these cards: nothing is recorded, so resting cards can be looked at again. */
  private async practice(weak: WeakCard[]): Promise<void> {
    const { plugin } = this;
    const name = "Weak spots";
    const existing = plugin.settings.filteredDecks.find((d) => d.name === name);
    const cards = weak.map((w) => w.item.ref.key ?? w.item.ref.uid);
    const def: FilteredDeck = { id: existing?.id ?? `w-${Date.now().toString(36)}`, name, search: `rated:${Math.max(1, RANGES.find((r) => r.id === this.range)!.days)}:1`, limit: cards.length, order: "due", reschedule: false };
    await plugin.buildFilteredDeck(def, cards);
    void plugin.openFiltered(def.id);
  }

  private row(parent: HTMLElement, w: WeakCard, today: number): void {
    const { plugin } = this;
    const { ref, state } = w.item;
    const box = parent.createDiv({ cls: "fc-leech" });
    const resting = !!plugin.settings.restAfterMisses && !!state && missesSince(state, today) >= plugin.settings.restAfterMisses;
    box.createDiv({
      cls: "fc-leech-meta fc-muted",
      text: [topicOf(ref), `missed ${w.misses} of ${w.answers}`, resting ? "resting until tomorrow" : "", state?.suspended ? "suspended" : ""].filter(Boolean).join(" · "),
    });
    // The fact with its answer filled in; pictures are left to the note (a long list of them is slow on a phone).
    const faces = cardFaces(ref.card, ref.slot, plugin.crownSplitFor(ref));
    const text = (faces.kind === "basic" ? `${faces.question}\n\n**${faces.answer}**` : faces.answer).replace(/!\[\[[^\]]*\]\]/g, "");
    void MarkdownRenderer.render(this.app, text, box.createDiv({ cls: "markdown-rendered fc-leech-card" }), ref.path, this.component!);
    const explainEl = box.createDiv({ cls: "fc-weak-explain" });
    const showExplanation = (md: string) => {
      explainEl.empty();
      void MarkdownRenderer.render(this.app, md, explainEl.createDiv({ cls: "markdown-rendered" }), ref.path, this.component!);
    };
    void plugin.ai.savedExplanation(ref).then((saved) => {
      if (saved) showExplanation(saved);
    });

    const bar = box.createDiv({ cls: "fc-leech-actions" });
    const btn = (label: string, title: string, fn: (b: HTMLButtonElement) => Promise<void> | void, cta = false) => {
      const b = bar.createEl("button", { text: label, cls: cta ? "mod-cta" : "", attr: { "aria-label": title } });
      b.onclick = () => void fn(b);
    };
    const related = plugin.relatedFor(ref)[0];
    btn(related ? `Open note: ${related.basename}` : "Open note", "Read about it", () => {
      const file = related ?? this.app.vault.getFileByPath(ref.path);
      if (!file) return void new Notice("Note not found.");
      void this.app.workspace.getLeaf("tab").openFile(file, related ? undefined : { eState: { line: ref.card.startLine } });
    }, true);
    btn("Explain", "Why the answer is what it is, with a memory hook (AI, saved after the first time)", async (b) => {
      b.disabled = true;
      b.setText("Explaining…");
      const out = await plugin.ai.explain(ref);
      b.disabled = false;
      b.setText("Explain");
      if (out) showExplanation(out);
    });
    btn("Rewrite", "Edit the card", () => new EditCardModal(this.app, plugin, ref, () => this.render()).open());
    if (ref.card.type === "cloze" && !plugin.isCrowned(ref)) {
      btn("🦴 Reveal one by one", "Reveal the answers one at a time", async () => {
        await plugin.setCrowns([ref], true);
        new Notice("Its answers now reveal one by one.");
      });
    }
  }
}
