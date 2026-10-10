/** A first version of Anki's browser (spec 0003 §7): search, preview and bulk actions. */
import { Component, debounce, ItemView, MarkdownRenderer, Menu, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { renderWhenVisible } from "./lazy-render";
import { State } from "ts-fsrs";
import { cardFaces } from "../../core/faces";
import type { LogEvent } from "../../core/log";
import type { QueueItem } from "../../core/queue";
import { formatInterval } from "../../core/scheduler";
import { compileSearch } from "../../core/search";
import type FlashcardsPlugin from "../../main";
import { masksForSlot } from "../../core/occlusion";
import { renderFigure } from "../occlusion-render";
import { CardInfoModal, SetDueModal } from "../modals/card";
import { FLAG_NAMES } from "./review";

export const VIEW_BROWSE = "flashcards-browse";
const MAX_ROWS = 300;

function plain(md: string): string {
  return md
    .replace(/<span class="fc-cloze">\[(.*?)\]<\/span>/g, "[$1]")
    .replace(/!\[\[[^\]]*\]\]/g, "🖼")
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/==|\*\*|__|`/g, "")
    // Imported Anki cards keep simple HTML: show line breaks as " / " and drop other tags.
    .replace(/\s*<br\s*\/?>\s*/gi, " / ")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export class BrowseView extends ItemView {
  private query = "";
  private input?: HTMLInputElement;
  private selected = new Set<string>();
  private previewUid?: string;
  private results: QueueItem[] = [];
  private previewComponent?: Component;
  private listEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private countEl!: HTMLElement;
  private bulkEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: FlashcardsPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_BROWSE;
  }

  getDisplayText(): string {
    return "Browse cards";
  }

  getIcon(): string {
    return "search";
  }

  async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass("fc-browse");
    const bar = el.createDiv({ cls: "fc-browse-bar" });
    const input = bar.createEl("input", {
      type: "search",
      placeholder: "Search: deck:Ortho tag:high-yield is:due is:onebyone flag:1 prop:ivl>30 -is:new text…",
      cls: "fc-browse-search",
    });
    input.value = this.query;
    this.input = input;
    const run = debounce(() => this.refresh(), 250, true);
    input.addEventListener("input", () => {
      this.query = input.value;
      run();
    });
    this.countEl = bar.createDiv({ cls: "fc-muted fc-browse-count" });
    this.bulkEl = el.createDiv({ cls: "fc-browse-bulk" });
    const body = el.createDiv({ cls: "fc-browse-body" });
    this.listEl = body.createDiv({ cls: "fc-browse-list" });
    this.previewEl = body.createDiv({ cls: "fc-browse-preview" });
    this.registerEvent(this.plugin.events.on("changed", renderWhenVisible(this, () => run())));
    this.refresh();
  }

  getState(): Record<string, unknown> {
    return { query: this.query };
  }

  /** Open with a search already filled in (e.g. from a heatmap or stats click). */
  async setState(state: { query?: string }, result: ViewStateResult): Promise<void> {
    if (state && typeof state.query === "string") {
      this.query = state.query;
      if (this.input) this.input.value = state.query;
      if (this.listEl) this.refresh();
    }
    await super.setState(state, result);
  }

  async onClose(): Promise<void> {
    this.previewComponent?.unload();
  }

  private refresh(): void {
    if (!this.plugin.ready) {
      this.countEl.setText("Loading…");
      return;
    }
    let match: (i: QueueItem) => boolean;
    try {
      match = compileSearch(this.query, Date.now(), this.plugin.settings.dayStartHour, this.plugin.searchCtx);
    } catch {
      match = () => false;
    }
    this.results = this.plugin.items(null).filter(match);
    const uids = new Set(this.results.map((r) => r.ref.uid));
    for (const u of [...this.selected]) if (!uids.has(u)) this.selected.delete(u);
    this.countEl.setText(
      `${this.results.length} card${this.results.length === 1 ? "" : "s"}${this.results.length > MAX_ROWS ? ` (showing first ${MAX_ROWS})` : ""}`,
    );
    this.renderList();
    this.renderBulk();
    this.renderPreview();
  }

  private renderList(): void {
    const list = this.listEl;
    list.empty();
    const table = list.createEl("table", { cls: "fc-browse-table" });
    const head = table.createEl("thead").createEl("tr");
    const all = head.createEl("th").createEl("input", { type: "checkbox" });
    all.checked = this.results.length > 0 && this.results.slice(0, MAX_ROWS).every((r) => this.selected.has(r.ref.uid));
    all.onchange = () => {
      for (const r of this.results.slice(0, MAX_ROWS)) {
        if (all.checked) this.selected.add(r.ref.uid);
        else this.selected.delete(r.ref.uid);
      }
      this.renderList();
      this.renderBulk();
    };
    for (const col of ["Card", "Deck", "Due", "Interval", "Difficulty", "Lapses"]) head.createEl("th", { text: col });
    const body = table.createEl("tbody");
    const now = Date.now();
    for (const item of this.results.slice(0, MAX_ROWS)) {
      const { ref, state } = item;
      const c = state?.card;
      const isNew = !c || c.state === State.New;
      const tr = body.createEl("tr", {
        cls: [
          "fc-browse-row",
          ref.uid === this.previewUid ? "is-selected" : "",
          state?.suspended ? "fc-suspended" : "",
          state?.flag ? `fc-row-flag-${state.flag}` : "",
          state?.marked ? "fc-row-marked" : "",
        ].join(" "),
      });
      const cb = tr.createEl("td").createEl("input", { type: "checkbox" });
      cb.checked = this.selected.has(ref.uid);
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = () => {
        if (cb.checked) this.selected.add(ref.uid);
        else this.selected.delete(ref.uid);
        this.renderBulk();
      };
      const faces = cardFaces(ref.card, ref.slot);
      tr.createEl("td", { text: plain(faces.question).slice(0, 120), cls: "fc-browse-front" });
      tr.createEl("td", { text: ref.deck.split("/").pop() ?? "", cls: "fc-muted" });
      tr.createEl("td", {
        text: isNew ? "New" : state?.suspended ? "Suspended" : c.due.getTime() <= now ? "Due" : formatInterval(c.due.getTime() - now),
      });
      tr.createEl("td", { text: isNew ? "" : formatInterval(c.scheduled_days * 86400000 || c.due.getTime() - (c.last_review?.getTime() ?? now)) });
      tr.createEl("td", { text: isNew ? "" : `${Math.round(c.difficulty * 10)}%` });
      tr.createEl("td", { text: isNew ? "" : String(c.lapses) });
      tr.onclick = () => {
        this.previewUid = ref.uid;
        this.renderList();
        this.renderPreview();
      };
    }
  }

  private selectedItems(): QueueItem[] {
    return this.results.filter((r) => this.selected.has(r.ref.uid));
  }

  private renderBulk(): void {
    const el = this.bulkEl;
    el.empty();
    const items = this.selectedItems();
    if (!items.length) return;
    el.createSpan({ text: `${items.length} selected`, cls: "fc-muted" });
    const btn = (text: string, fn: () => void) => el.createEl("button", { text }).addEventListener("click", fn);
    btn("Suspend", () => void this.bulk(items, "suspend"));
    btn("Unsuspend", () => void this.bulk(items, "unsuspend"));
    btn("Reset", () => void this.bulk(items, "reset"));
    btn("Set due date…", () => new SetDueModal(this.app, this.plugin, items.map((i) => i.ref), () => this.refresh()).open());
    btn("Flag…", () => {
      const menu = new Menu();
      FLAG_NAMES.forEach((name, n) =>
        menu.addItem((i) => i.setTitle(n ? `${name} flag` : "Remove flag").onClick(() => void this.bulk(items, "flag", n))),
      );
      menu.showAtPosition({ x: el.getBoundingClientRect().left + 200, y: el.getBoundingClientRect().bottom });
    });
    btn("🦴 One by one…", () => {
      const menu = new Menu();
      const set = (on: boolean | undefined, done: string) => async () => {
        const n = await this.plugin.setCrowns(items.map((i) => i.ref), on);
        new Notice(`${n} card${n === 1 ? "" : "s"} ${done}.`);
      };
      menu.addItem((i) => i.setTitle("Reveal one by one").setIcon("bone").onClick(set(true, "switched to one by one")));
      menu.addItem((i) => i.setTitle("Show all at once").onClick(set(false, "switched to all-at-once")));
      menu.addItem((i) => i.setTitle("Automatic (lists on separate lines)").onClick(set(undefined, "back to automatic")));
      menu.showAtPosition({ x: el.getBoundingClientRect().left + 200, y: el.getBoundingClientRect().bottom });
    });
    btn("Clear selection", () => {
      this.selected.clear();
      this.renderList();
      this.renderBulk();
    });
  }

  private async bulk(items: QueueItem[], type: "suspend" | "unsuspend" | "reset" | "flag", flag = 0): Promise<void> {
    const base = Date.now();
    let skipped = 0;
    const events: LogEvent[] = [];
    // Bottom-up within each note: writing an ID can add a line (occlusion blocks), which would
    // otherwise shift the cards below it and make their writes fail the safety check.
    const ordered = [...items].sort((a, b) => a.ref.path.localeCompare(b.ref.path) || b.ref.card.startLine - a.ref.card.startLine);
    for (const item of ordered) {
      // Unsuspend, reset and unflag mean nothing for a card that has never been reviewed.
      if (!item.ref.key && type !== "suspend" && !(type === "flag" && flag)) {
        skipped++;
        continue;
      }
      const key = await this.plugin.ensureKey(item.ref);
      if (!key) {
        skipped++;
        continue;
      }
      const ts = new Date(base + events.length).toISOString();
      events.push(type === "flag" ? { ts, type, key, flag } : { ts, type, key });
    }
    await this.plugin.logEvents(events);
    const n = events.length;
    new Notice(`${n} card${n === 1 ? "" : "s"} updated${skipped ? `, ${skipped} skipped` : ""}.`);
    this.refresh();
  }

  private renderPreview(): void {
    const el = this.previewEl;
    el.empty();
    this.previewComponent?.unload();
    const item = this.results.find((r) => r.ref.uid === this.previewUid);
    if (!item) {
      el.createDiv({ cls: "fc-muted", text: "Select a card to preview it." });
      return;
    }
    this.previewComponent = new Component();
    this.previewComponent.load();
    const { ref } = item;
    const faces = cardFaces(ref.card, ref.slot, this.plugin.crownSplitFor(ref));
    const actions = el.createDiv({ cls: "fc-browse-actions" });
    const act = (icon: string, label: string, fn: () => void) => {
      const b = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.onclick = fn;
    };
    act("file-text", "Open note", () => {
      const file = this.app.vault.getFileByPath(ref.path);
      if (file) void this.app.workspace.getLeaf("tab").openFile(file, { eState: { line: ref.card.startLine } });
    });
    act("info", "Card info", () => new CardInfoModal(this.app, this.plugin, ref, item.state).open());
    act(item.state?.suspended ? "play" : "pause", item.state?.suspended ? "Unsuspend" : "Suspend", () =>
      void this.bulk([item], item.state?.suspended ? "unsuspend" : "suspend"),
    );
    act("calendar", "Set due date", () => new SetDueModal(this.app, this.plugin, [ref], () => this.refresh()).open());
    if (ref.card.type === "cloze") {
      const on = this.plugin.isCrowned(ref);
      const b = actions.createEl("button", {
        cls: `clickable-icon fc-crown-toggle${on ? " is-active" : ""}`,
        attr: { "aria-label": on ? "Answers reveal one by one. Click for all at once" : "Reveal this card's answers one by one" },
      });
      setIcon(b, "bone");
      b.onclick = () => void this.plugin.setCrowns([ref], !on);
    }
    el.createDiv({ cls: "fc-muted fc-browse-where", text: `${ref.path} · line ${ref.card.startLine + 1}` });
    const render = (md: string, cls: string) => {
      const d = el.createDiv({ cls: `markdown-rendered ${cls}` });
      void MarkdownRenderer.render(this.app, md, d, ref.path, this.previewComponent!);
    };
    if (faces.kind === "occlusion" && ref.card.occlusion) {
      // Image occlusion: the figure with this card's boxes covered, then revealed (spec 0004).
      const occ = ref.card.occlusion;
      if (occ.header) render(occ.header, "fc-question");
      const active = masksForSlot(occ, ref.slot);
      renderFigure(this.app, el, occ, ref.path, { active, phase: "front" });
      el.createEl("hr");
      renderFigure(this.app, el, occ, ref.path, { active, phase: "back", zoomable: true });
      if (faces.extra) render(faces.extra, "fc-extra");
      return;
    }
    render(faces.question, "fc-question");
    el.createEl("hr");
    render(faces.answer, "fc-answer");
    if (faces.extra) render(faces.extra, "fc-extra");
  }
}
