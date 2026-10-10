/** Anki's deck list: New / Learn / Due per deck, collapsible sub-decks (spec 0003 §1.1). */
import { ItemView, Menu, sanitizeHTMLToDom, Scope, setIcon, type WorkspaceLeaf } from "obsidian";
import { renderWhenVisible } from "./lazy-render";
import { keyString } from "../settings";
import { counts } from "../../core/queue";
import type FlashcardsPlugin from "../../main";
import { pickAndImportApkg } from "../anki-import";
import { syncLines } from "../logstore";
import { DeckOptionsModal } from "../modals/deck-options";
import { FilteredDeckModal } from "../modals/filtered";
import { RenameDeckModal } from "../modals/rename-deck";
import { moveDeckKey } from "../../core/collection";
import { heatmapData, renderHeatmap } from "../heatmap";
import { cardsPerMinute, studyDay } from "../../core/stats";

export const VIEW_DECKS = "flashcards-decks";

interface DeckNode {
  name: string;
  path: string;
  children: Map<string, DeckNode>;
}

export class DeckView extends ItemView {
  /** Collapsed decks, remembered on this device across restarts. */
  private collapsed = new Set<string>();
  /** The year the heatmap shows (undefined = this year). */
  private heatmapYear: { year?: number } = {};
  private static readonly COLLAPSED_KEY = "flashcards-collapsed-decks";
  /** Show hidden decks (dimmed) on this device, so they can be opened or unhidden. */
  private showHidden = false;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: FlashcardsPlugin,
  ) {
    super(leaf);
    // Anki's main-window keys: S study, B browse, A add (remappable in settings).
    this.scope = new Scope(this.app.scope);
    this.scope.register(null, null, (e) => {
      const k = keyString(e);
      const keys = this.plugin.settings.keys;
      if (k === "s") void this.plugin.openReview(null);
      else if (keys.browse.includes(k)) void this.plugin.openBrowse();
      else if (keys.addCard.includes(k)) this.plugin.openAddCard(null);
      else if (keys.stats.includes(k)) void this.plugin.openStats(null);
      else if (keys.filteredDeck.includes(k)) new FilteredDeckModal(this.app, this.plugin).open();
      else return true;
      return false;
    });
    const saved: unknown = this.app.loadLocalStorage(DeckView.COLLAPSED_KEY);
    if (Array.isArray(saved)) for (const d of saved) if (typeof d === "string") this.collapsed.add(d.toLowerCase());
  }

  private isCollapsed(path: string): boolean {
    return this.collapsed.has(path.toLowerCase());
  }

  private toggleCollapsed(path: string): void {
    const k = path.toLowerCase();
    if (this.collapsed.has(k)) this.collapsed.delete(k);
    else this.collapsed.add(k);
    this.app.saveLocalStorage(DeckView.COLLAPSED_KEY, [...this.collapsed]);
  }

  /** Anki's deck gear menu: Rename, Options, plus Hide / Unhide. */
  private deckMenu(path: string, hidden: boolean): Menu {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Rename")
        .setIcon("pencil")
        .onClick(() => new RenameDeckModal(this.app, this.plugin, path, (from, to) => this.renamed(from, to)).open()),
    );
    menu.addItem((i) =>
      i
        .setTitle("Options")
        .setIcon("settings")
        .onClick(() => new DeckOptionsModal(this.app, this.plugin, path).open()),
    );
    menu.addItem((i) =>
      i
        .setTitle(hidden ? "Unhide" : "Hide")
        .setIcon(hidden ? "eye" : "eye-off")
        .onClick(() => void this.plugin.setDeckHidden(path, !hidden)),
    );
    return menu;
  }

  /** Keep a renamed deck's collapsed state. */
  private renamed(from: string, to: string): void {
    this.collapsed = new Set([...this.collapsed].map((k) => moveDeckKey(k, from, to)));
    this.app.saveLocalStorage(DeckView.COLLAPSED_KEY, [...this.collapsed]);
  }

  getViewType(): string {
    return VIEW_DECKS;
  }

  getDisplayText(): string {
    return "Decks";
  }

  getIcon(): string {
    return "layers";
  }

  async onOpen(): Promise<void> {
    const refresh = renderWhenVisible(this, () => this.render());
    this.registerEvent(this.plugin.events.on("changed", refresh));
    // Learning cards become due as time passes.
    this.registerInterval(window.setInterval(refresh, 60_000));
    this.render();
  }

  private tree(): DeckNode {
    const root: DeckNode = { name: "", path: "", children: new Map() };
    for (const ref of this.plugin.index.refs()) {
      let node = root;
      for (const part of ref.deck.split("/")) {
        // Tag decks and folder decks can differ only in case ("ortho" vs "Ortho"): merge them.
        const k = part.toLowerCase();
        const path = node.path ? `${node.path}/${part}` : part;
        if (!node.children.has(k)) node.children.set(k, { name: part, path, children: new Map() });
        node = node.children.get(k)!;
      }
    }
    return root;
  }

  private static SNAPSHOT_KEY = "flashcards-deck-list-snapshot";

  /** Keep this device's last drawn deck table + totals for the next startup (see render). */
  private saveSnapshot(table: HTMLElement, info: HTMLElement): void {
    const day = studyDay(Date.now(), this.plugin.settings.dayStartHour);
    this.app.saveLocalStorage(DeckView.SNAPSHOT_KEY, { day, html: table.outerHTML + info.outerHTML });
  }

  render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("fc-decks");
    if (!this.plugin.ready) {
      // Show the last session's deck list (same study day only) while the cards load, so the
      // phone isn't blank for seconds at startup; it's redrawn with live counts once ready.
      const snap = this.app.loadLocalStorage(DeckView.SNAPSHOT_KEY) as { day: number; html: string } | null;
      const day = studyDay(Date.now(), this.plugin.settings.dayStartHour);
      if (snap && snap.day === day && typeof snap.html === "string") {
        const stale = el.createDiv({ cls: "fc-deck-snapshot" });
        stale.append(sanitizeHTMLToDom(snap.html));
      }
      el.createDiv({ cls: "fc-muted fc-loading", text: "Loading cards…" });
      return;
    }
    const root = this.tree();
    if (root.children.size === 0) {
      el.createEl("h3", { text: "No flashcards yet" });
      el.createEl("p", {
        text: "Add #flashcards to a note, then write a card: a line with a ==cloze==, or Question :: Answer. The lines under it are the back.",
      });
      const imp = el.createEl("button", { text: "Import a deck (.apkg)" });
      imp.onclick = () => pickAndImportApkg(this.plugin);
      return;
    }

    const table = el.createEl("table", { cls: "fc-deck-table" });
    const head = table.createEl("thead").createEl("tr");
    head.createEl("th", { text: "Deck" });
    head.createEl("th", { text: "New", cls: "fc-num" });
    head.createEl("th", { text: "Learn", cls: "fc-num" });
    head.createEl("th", { text: "Due", cls: "fc-num" });
    head.createEl("th");
    const body = table.createEl("tbody");
    const now = new Date();
    // Each deck's queue once per draw (rows and the totals line both need the top-level ones).
    const queues = new Map<string, ReturnType<typeof counts>>();
    const countsFor = (path: string) => {
      let c = queues.get(path);
      if (!c) queues.set(path, (c = counts(this.plugin.queue(path, now))));
      return c;
    };

    const hiddenCount = this.plugin.settings.hiddenDecks.length;
    const addRows = (node: DeckNode, depth: number) => {
      const sorted = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const child of sorted) {
        const hidden = this.plugin.isDeckHidden(child.path);
        if (hidden && !this.showHidden) continue;
        const c = countsFor(child.path);
        const tr = body.createEl("tr", { cls: hidden ? "fc-hidden-deck" : "" });
        // The gear (or right-click / long-press) opens Anki's deck menu.
        tr.oncontextmenu = (e) => {
          e.preventDefault();
          this.deckMenu(child.path, hidden).showAtMouseEvent(e);
        };
        const nameCell = tr.createEl("td", { cls: "fc-deck-name" });
        nameCell.style.paddingLeft = `${depth * 1.2 + 0.4}em`;
        const toggle = nameCell.createSpan({ cls: "fc-toggle" });
        if (child.children.size) {
          setIcon(toggle, this.isCollapsed(child.path) ? "chevron-right" : "chevron-down");
          toggle.onclick = (e) => {
            e.stopPropagation();
            this.toggleCollapsed(child.path);
            this.render();
          };
        }
        const link = nameCell.createEl("a", { text: child.name, cls: "fc-deck-link" });
        link.onclick = () => this.plugin.openReview(child.path);
        tr.createEl("td", { text: String(c.fresh), cls: `fc-num fc-new ${c.fresh ? "" : "fc-zero"}` });
        tr.createEl("td", { text: String(c.learning), cls: `fc-num fc-learn ${c.learning ? "" : "fc-zero"}` });
        tr.createEl("td", { text: String(c.review), cls: `fc-num fc-due ${c.review ? "" : "fc-zero"}` });
        const gear = tr.createEl("td", { cls: "fc-gear" }).createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Deck menu" } });
        setIcon(gear, "settings");
        gear.onclick = (e) => this.deckMenu(child.path, hidden).showAtMouseEvent(e);
        if (child.children.size && !this.isCollapsed(child.path)) addRows(child, depth + 1);
      }
    };
    addRows(root, 0);

    // Filtered decks, in blue as in Anki. Their cards also stay in their home decks.
    for (const def of this.plugin.settings.filteredDecks) {
      const c = counts(this.plugin.filteredQueueFor(def));
      const tr = body.createEl("tr", { cls: "fc-filtered-row" });
      const nameCell = tr.createEl("td", { cls: "fc-deck-name fc-deck-name-flat" });
      nameCell.createSpan({ cls: "fc-toggle" });
      const link = nameCell.createEl("a", { text: def.name, cls: "fc-deck-link fc-filtered-name", attr: { title: `Filtered deck: ${def.search}` } });
      link.onclick = () => void this.plugin.openFiltered(def.id);
      tr.createEl("td", { text: String(c.fresh), cls: `fc-num fc-new ${c.fresh ? "" : "fc-zero"}` });
      tr.createEl("td", { text: String(c.learning), cls: `fc-num fc-learn ${c.learning ? "" : "fc-zero"}` });
      tr.createEl("td", { text: String(c.review), cls: `fc-num fc-due ${c.review ? "" : "fc-zero"}` });
      const gear = tr.createEl("td", { cls: "fc-gear" }).createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Filtered deck options" } });
      setIcon(gear, "settings");
      gear.onclick = () => new FilteredDeckModal(this.app, this.plugin, def).open();
    }

    // Anki's line, then the More Decks Stats and Time Left add-on's totals beside it.
    const t = this.plugin.today();
    const mins = t.timeMs / 60000;
    const per = t.answers ? (t.timeMs / 1000 / t.answers).toFixed(2) : "0";
    const totals = { fresh: 0, learning: 0, review: 0 };
    for (const child of root.children.values()) {
      if (this.plugin.isDeckHidden(child.path)) continue;
      const c = countsFor(child.path);
      totals.fresh += c.fresh;
      totals.learning += c.learning;
      totals.review += c.review;
    }
    const due = totals.learning + totals.review;
    const total = totals.fresh + due;
    const hm = heatmapData(this.plugin, null);
    const cpm = cardsPerMinute(hm.rows, studyDay(Date.now(), this.plugin.settings.dayStartHour));

    const info = el.createDiv({ cls: "fc-deck-info" });
    const left = info.createDiv({ cls: "fc-deck-info-main" });
    left.createDiv({
      cls: "fc-today",
      text: `Studied ${t.answers} card${t.answers === 1 ? "" : "s"} in ${mins.toFixed(2)} minutes today (${per}s/card)`,
    });
    const line = left.createDiv({ cls: "fc-deck-totals" });
    const part = (label: string, n: number, cls: string) => {
      line.createSpan({ text: `${label}: ` });
      line.createSpan({ text: String(n), cls: `fc-total-n ${cls}` });
      line.appendText(" ");
    };
    part("New", totals.fresh, "fc-new");
    part("Learn", totals.learning, "fc-t-learn");
    part("Reviews", totals.review, "fc-t-review");
    part("Due", due, "fc-due");
    part("Total", total, "fc-t-total");
    const right = info.createDiv({ cls: "fc-deck-info-side" });
    right.createDiv({ text: "Average:" });
    right.createDiv({ text: cpm ? `${cpm.toFixed(1)} cards/minute` : "—" });
    right.createDiv({ cls: "fc-time-left", text: cpm ? `${Math.round(total / cpm)} minutes more` : "" });

    // Why the numbers are what they are, when the pacing options are holding cards back.
    const s = this.plugin.settings;
    if (s.adaptiveNew || s.restAfterMisses) {
      const q = this.plugin.queue(null, now);
      const notes: string[] = [];
      // New cards are held per deck (each deck has its own daily limit), so add up the top-level decks.
      let held = 0;
      let pile = 0;
      for (const child of root.children.values()) {
        if (this.plugin.isDeckHidden(child.path)) continue;
        const dq = this.plugin.queue(child.path, now);
        held += dq.newHeld ?? 0;
        if (dq.newHeld) pile = Math.max(pile, dq.pile ?? 0);
      }
      if (held) notes.push(`${held} new card${held === 1 ? "" : "s"} paused: ${pile} cards answered today are still in learning (new cards come back at ${s.adaptiveNewPile} or fewer).`);
      if (q.rested) notes.push(`${q.rested} card${q.rested === 1 ? "" : "s"} resting until tomorrow after ${s.restAfterMisses} misses today (see Weak spots).`);
      for (const text of notes) el.createDiv({ cls: "fc-muted fc-pacing", text });
    }

    if (!this.showHidden) this.saveSnapshot(table, info);
    if (this.plugin.settings.showHeatmap) renderHeatmap(el, this.plugin, null, hm, this.heatmapYear, () => this.render());

    const buttons = el.createDiv({ cls: "fc-deck-buttons" });
    const all = buttons.createEl("button", { text: "Study all", cls: "mod-cta" });
    all.onclick = () => this.plugin.openReview(null);
    const add = buttons.createEl("button", { text: "Add" });
    add.onclick = () => this.plugin.openAddCard(null);
    const browse = buttons.createEl("button", { text: "Browse" });
    browse.onclick = () => this.plugin.openBrowse();
    const stats = buttons.createEl("button", { text: "Stats" });
    stats.onclick = () => this.plugin.openStats(null);
    const filtered = buttons.createEl("button", { text: "Create Filtered Deck" });
    filtered.onclick = () => new FilteredDeckModal(this.app, this.plugin).open();
    const weak = this.plugin.weakToday().length;
    const wb = buttons.createEl("button", { text: weak ? `Weak spots (${weak})` : "Weak spots" });
    wb.setAttr("aria-label", "The cards and topics you missed most");
    wb.onclick = () => void this.plugin.openWeak();
    const leeches = this.plugin.leeches().length;
    if (leeches) {
      const lb = buttons.createEl("button", { text: `Leeches (${leeches})` });
      lb.onclick = () => void this.plugin.openLeeches();
    }
    const imp = buttons.createEl("button", { text: "Import deck" });
    imp.onclick = () => pickAndImportApkg(this.plugin);
    if (hiddenCount) {
      const label = this.showHidden ? "Hide Hidden Decks" : `Show Hidden Decks (${hiddenCount})`;
      const toggle = buttons.createEl("button", { text: label, cls: this.showHidden ? "is-active" : "" });
      toggle.onclick = async () => {
        this.showHidden = !this.showHidden;
        // Hidden decks are only read when shown; the rebuild redraws every view.
        await this.plugin.index.setWithHidden(this.showHidden);
        this.render();
      };
    }
    // The version, so each device can be checked after an update syncs.
    el.createDiv({ cls: "fc-muted fc-version", text: `Osteon ${this.plugin.manifest.version}` });
    // What has arrived from the other devices: their newest answer, and the version that wrote it.
    for (const line of syncLines(this.plugin.devices, this.plugin.logs.device, this.plugin.manifest.version, new Date())) {
      el.createDiv({ cls: "fc-muted fc-version", text: line });
    }
  }
}
