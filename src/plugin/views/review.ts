/** Anki's review screen (spec 0003 §1.2–§3). */
import { heatmapData, renderHeatmap } from "../heatmap";
import { Component, ItemView, MarkdownRenderer, MarkdownView, Menu, Notice, Platform, prepareFuzzySearch, Scope, setIcon, SuggestModal, TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { CardRef } from "../../core/collection";
import { cardFaces } from "../../core/faces";
import { RATINGS, type RatingName } from "../../core/log";
import { counts, nextCard, whichCount, type Queue, type QueueItem } from "../../core/queue";
import { formatInterval, newCard, previewDue } from "../../core/scheduler";
import type FlashcardsPlugin from "../../main";
import { masksForSlot } from "../../core/occlusion";
import { excerptLine, searchNotes, type SearchableNote } from "../../core/note-search";
import { imageEmbeds } from "../../core/parser";
import { renderFigure } from "../occlusion-render";
import { CardInfoModal, EditCardModal, SetDueModal } from "../modals/card";
import { CustomStudyModal, FilteredDeckModal } from "../modals/filtered";
import type { Preset } from "../../core/presets";
import { DeckOptionsModal } from "../modals/deck-options";
import { applyCardTheme, keyString, type ActionName } from "../settings";
import { VIEW_DECKS } from "./decks";
import { timed, trace } from "../trace";

export const FLAG_NAMES = ["", "Red", "Orange", "Green", "Blue", "Pink", "Turquoise", "Purple"];

export const VIEW_REVIEW = "flashcards-review";

type Phase = "overview" | "front" | "back" | "done";

const LABEL: Record<RatingName, string> = { again: "Again", hard: "Hard", good: "Good", easy: "Easy" };

export class ReviewView extends ItemView {
  private deck: string | null = null;
  /** A filtered deck's ID (spec 0008), instead of a deck. */
  private filtered: string | null = null;
  /** Preview (no-reschedule) sessions: cards finished, and the order after Again moves. */
  private previewDone = new Set<string>();
  private previewOrder: string[] | null = null;
  private phase: Phase = "overview";
  private heatmapYear: { year?: number } = {};
  private current?: QueueItem;
  private shownAt = 0;
  private answered = 0;
  private undoStack: Array<{ key: string; ts: string; leechTs?: string }> = [];
  /** A timed sitting: when it ends (ms), how long it was, and whether the time is up. */
  private until = 0;
  private timedMins = 0;
  private timeUp = false;
  private cardComponent?: Component;
  private noteLeaf?: WorkspaceLeaf;
  private busy = false;
  /** Toggle masks (T): uncover every box on an occlusion card's back. */
  private showAllMasks = false;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: FlashcardsPlugin,
  ) {
    super(leaf);
    // Obsidian activates a view's scope whenever its tab is active, so review keys work
    // without the card having DOM focus, and never fire while typing in a note.
    this.scope = new Scope(this.app.scope);
    this.scope.register(null, null, (e) => (this.onKey(e) ? false : true));
  }

  getViewType(): string {
    return VIEW_REVIEW;
  }

  getDisplayText(): string {
    const f = this.filtered ? this.plugin.filteredDeck(this.filtered) : undefined;
    if (f) return `Review: ${f.name}`;
    return this.deck ? `Review: ${this.deck.split("/").pop()}` : "Review";
  }

  getIcon(): string {
    return "layers";
  }

  getState(): Record<string, unknown> {
    return { deck: this.deck, filtered: this.filtered };
  }

  async setState(state: { deck?: string | null; filtered?: string | null }, result: ViewStateResult): Promise<void> {
    this.deck = state?.deck ?? null;
    this.filtered = state?.filtered ?? null;
    this.previewDone = new Set();
    this.previewOrder = null;
    this.phase = "overview";
    this.current = undefined;
    this.answered = 0;
    this.undoStack = [];
    this.until = 0;
    this.timeUp = false;
    trace(`setState deck=${this.deck}`);
    this.render();
    trace("setState rendered");
    await super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("fc-review");
    if (Platform.isMobile) {
      this.registerDomEvent(window, "devicemotion", (e) => this.onMotion(e));
      this.registerDomEvent(window, "resize", () => this.clearNavbar());
    }
    // Internal links on a card open the note in another tab instead of doing nothing.
    this.registerDomEvent(this.contentEl, "click", (e) => {
      const a = (e.target as HTMLElement).closest("a.internal-link");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
      void this.app.workspace.openLinkText(href, this.current?.ref.path ?? "", Platform.isMobile ? "tab" : "split");
    });
    this.registerEvent(
      this.plugin.events.on("changed", () => {
        if (this.phase === "overview" || this.phase === "done") this.render();
      }),
    );
    // Learning cards come due while the "done" screen is showing.
    this.registerInterval(
      window.setInterval(() => {
        if (this.phase === "done" && !this.timeUp && this.pickNext()) this.showFront();
      }, 15_000),
    );
    this.render();
  }

  async onClose(): Promise<void> {
    window.clearInterval(this.timerId);
    window.clearTimeout(this.autoTimer);
    this.plugin.terms.hide();
    this.cardComponent?.unload();
  }

  private filteredDef() {
    return this.filtered ? this.plugin.filteredDeck(this.filtered) : undefined;
  }

  private queue(): Queue {
    return timed("queue", () => this.queueInner());
  }

  private queueInner(): Queue {
    if (this.filtered) {
      const def = this.filteredDef();
      if (!def) return { learning: [], review: [], fresh: [] };
      if (def.reschedule) return this.plugin.filteredQueueFor(def);
      return this.plugin.filteredQueueFor({ ...def, cards: this.previewOrder ?? def.cards }, this.previewDone);
    }
    return this.plugin.queue(this.deck, new Date(), this.until > 0);
  }

  private pickNext(): QueueItem | undefined {
    return nextCard(this.queue(), new Date(), this.answered);
  }

  // ---- rendering -------------------------------------------------------------------------

  private render(): void {
    trace(`render (${this.phase})`);
    if (this.phase === "front" || this.phase === "back") return this.renderCard();
    this.plugin.terms.hide();
    this.cardComponent?.unload();
    this.cardComponent = undefined;
    const el = this.contentEl;
    el.empty();
    const wrap = el.createDiv({ cls: "fc-overview" });
    if (!this.plugin.ready) {
      wrap.createDiv({ cls: "fc-muted", text: "Loading cards…" });
      return;
    }
    const fdef = this.filteredDef();
    if (this.filtered && !fdef) {
      wrap.createEl("p", { text: "This filtered deck was deleted." });
      wrap.createEl("button", { text: "Decks" }).onclick = () => this.plugin.openDecks();
      return;
    }
    wrap.createEl("h2", { text: fdef ? fdef.name : this.deck ? this.deck.split("/").join(" › ") : "All decks", cls: fdef ? "fc-filtered-name" : "" });
    if (fdef) wrap.createDiv({ cls: "fc-muted", text: `Filtered deck: ${fdef.search || "(all cards)"}${fdef.reschedule ? "" : " · preview, answers aren't recorded"}` });
    const q = this.queue();
    const c = counts(q);
    if (this.phase === "done" && this.timeUp) {
      const left = c.fresh + c.learning + c.review;
      wrap.createEl("p", { cls: "fc-congrats", text: `Time's up: ${this.answered} card${this.answered === 1 ? "" : "s"} in ${this.timedMins} minutes.` });
      wrap.createEl("p", { cls: "fc-muted", text: left ? `${left} still waiting today. The ones most at risk came first.` : "Nothing else is waiting right now." });
      if (left) {
        const more = wrap.createEl("button", { text: "Keep going", cls: "fc-study-now" });
        more.onclick = () => {
          this.until = 0;
          this.timeUp = false;
          this.start();
        };
      }
    } else if (this.phase === "done" || (c.fresh + c.learning + c.review === 0 && !q.learning.length)) {
      wrap.createEl("p", { cls: "fc-congrats", text: "Congratulations! You have finished this deck for now." });
      if (q.nextLearningDue) {
        wrap.createEl("p", {
          cls: "fc-muted",
          text: `The next learning card will be ready in ${formatInterval(q.nextLearningDue.getTime() - Date.now())}.`,
        });
      }
    } else {
      const table = wrap.createEl("table", { cls: "fc-overview-counts" });
      const row = (label: string, n: number, cls: string) => {
        const tr = table.createEl("tr");
        tr.createEl("td", { text: label });
        tr.createEl("td", { text: String(n), cls: `fc-num ${cls}` });
      };
      row("New:", c.fresh, "fc-new");
      row("Learning:", c.learning, "fc-learn");
      row("To Review:", c.review, "fc-due");
      const btn = wrap.createEl("button", { text: "Study Now", cls: "mod-cta fc-study-now" });
      btn.onclick = () => this.start();
      if (!fdef) {
        // A timed sitting: stops cleanly when the time is up, most at-risk cards first.
        const timedRow = wrap.createDiv({ cls: "fc-timed" });
        timedRow.createSpan({ cls: "fc-muted", text: "Timed sitting: " });
        for (const mins of [5, 10, 15, 20]) {
          const b = timedRow.createEl("button", { text: `${mins} min` });
          b.onclick = () => {
            this.until = Date.now() + mins * 60000;
            this.timedMins = mins;
            this.timeUp = false;
            this.answered = 0;
            this.start();
          };
        }
      }
    }
    const nav = wrap.createDiv({ cls: "fc-deck-buttons" });
    const back = nav.createEl("button", { text: "Decks" });
    back.onclick = () => this.plugin.openDecks();
    if (fdef) {
      // Anki's filtered-deck overview: Rebuild, Empty, Options.
      nav.createEl("button", { text: "Rebuild" }).onclick = async () => {
        const n = await this.plugin.buildFilteredDeck(fdef);
        this.previewDone = new Set();
        this.previewOrder = null;
        this.phase = "overview";
        new Notice(`Rebuilt: ${n} card${n === 1 ? "" : "s"}.`);
        this.render();
      };
      nav.createEl("button", { text: "Empty" }).onclick = async () => {
        await this.plugin.emptyFilteredDeck(fdef.id);
        this.render();
      };
      nav.createEl("button", { text: "Options" }).onclick = () => new FilteredDeckModal(this.app, this.plugin, fdef).open();
      return;
    }
    nav.createEl("button", { text: "Custom Study" }).onclick = () => new CustomStudyModal(this.app, this.plugin, this.deck).open();
    const stats = nav.createEl("button", { text: "Stats" });
    stats.onclick = () => this.plugin.openStats(this.deck);
    // The Review Heatmap add-on also shows under a deck's overview, for that deck only.
    if (this.plugin.settings.showHeatmap) {
      timed("heatmap", () => renderHeatmap(el, this.plugin, this.deck, heatmapData(this.plugin, this.deck), this.heatmapYear, () => this.render()));
    }
  }

  private start(): void {
    trace("Study Now");
    const next = this.pickNext();
    if (!next) {
      this.phase = "done";
      this.render();
      return;
    }
    this.current = next;
    this.showFront();
  }

  private showFront(item?: QueueItem): void {
    if (item) this.current = item;
    // A timed sitting ends between cards (never in the middle of one, and not on an undo).
    if (!this.current && this.until && Date.now() >= this.until) {
      this.timeUp = true;
      this.phase = "done";
      this.plugin.api.emit("sessionEnd", this.deck);
      this.render();
      return;
    }
    if (!this.current) this.current = this.pickNext();
    if (!this.current) {
      if (this.phase !== "done") this.plugin.api.emit("sessionEnd", this.deck);
      this.phase = "done";
      this.render();
      return;
    }
    // A crown card has nothing to think about on its front: open it ready to reveal, so N (or a
    // tap) uncovers the first answer straight away.
    const { ref } = this.current;
    const crowned = this.isCrowned(ref);
    this.phase = crowned ? "back" : "front";
    this.showAllMasks = false;
    this.shownAt = Date.now();
    this.renderCard();
  }

  private showBack(): void {
    trace(`showBack (phase ${this.phase})`);
    if (this.phase !== "front") return;
    this.phase = "back";
    this.renderCard();
  }

  private renderCard(): void {
    const item = this.current;
    if (!item) return;
    trace(`renderCard ${this.phase} ${item.ref.card.type} ${item.ref.path}:${item.ref.card.startLine}`);
    const el = this.contentEl;
    el.empty();
    this.cardComponent?.unload();
    this.cardComponent = new Component();
    this.cardComponent.load();

    const { ref } = item;
    const faces = cardFaces(ref.card, ref.slot, this.plugin.crownSplitFor(ref));
    this.pendingRenders = [];
    this.crowns = undefined;
    this.crownsPending = false;
    this.plugin.terms.hide();

    // Top bar: where the card came from, and actions.
    const top = el.createDiv({ cls: "fc-topbar" });
    top.createDiv({ cls: "fc-trail", text: [ref.deck.split("/").join(" › "), ...ref.card.headings].join("  ·  ") });
    if (this.until) {
      const left = Math.max(0, Math.ceil((this.until - Date.now()) / 60000));
      top.createSpan({ cls: "fc-muted fc-time-left-sitting", text: `${left} min left` });
    }
    const actions = top.createDiv({ cls: "fc-actions" });
    const action = (icon: string, label: string, fn: () => void, enabled = true) => {
      const b = actions.createEl("button", { cls: "clickable-icon fc-action", attr: { "aria-label": label } });
      setIcon(b, icon);
      if (!enabled) b.setAttr("disabled", "true");
      b.onclick = (e) => {
        e.stopPropagation();
        fn();
      };
    };
    const flag = item.state?.flag ?? 0;
    const marked = item.state?.marked ?? false;
    if (marked) setIcon(top.createSpan({ cls: "fc-marked", attr: { "aria-label": "Marked" } }), "star");
    action("undo-2", "Undo", () => void this.undo(), this.undoStack.length > 0);
    if (ref.card.type === "cloze") {
      const on = this.isCrowned(ref);
      const b = actions.createEl("button", {
        cls: `clickable-icon fc-action fc-crown-toggle${on ? " is-active" : ""}`,
        attr: { "aria-label": on ? "Answers reveal one by one. Click for all at once" : "Reveal this card's answers one by one" },
      });
      setIcon(b, "bone");
      b.onclick = (e) => {
        e.stopPropagation();
        void this.toggleCrown();
      };
    }
    action("pencil", "Edit card", () => this.editCard());
    action("file-text", "Open note", () => void this.openNote());
    if (this.plugin.settings.ai.enabled) action("sparkles", "AI helper (explain this card, ask about it)", () => void this.plugin.openAssistant());
    action("flag", "Flag", () => {
      const menu = new Menu();
      FLAG_NAMES.forEach((name, n) => {
        if (n === 0) return;
        menu.addItem((i) => i.setTitle(`${name} flag`).setChecked(flag === n).onClick(() => void this.setFlag(n)));
      });
      if (flag) menu.addItem((i) => i.setTitle("Remove flag").onClick(() => void this.setFlag(0)));
      menu.showAtPosition({ x: actions.getBoundingClientRect().right - 160, y: actions.getBoundingClientRect().bottom });
    });
    action("more-horizontal", "More", () => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle(marked ? "Unmark" : "Mark").setIcon("star").onClick(() => void this.toggleMark()));
      menu.addItem((i) => i.setTitle("Bury card").setIcon("eye-off").onClick(() => void this.hide("bury")));
      menu.addItem((i) => i.setTitle("Suspend card").setIcon("pause").onClick(() => void this.hide("suspend")));
      menu.addItem((i) => i.setTitle("Set due date…").setIcon("calendar").onClick(() => this.setDue()));
      menu.addItem((i) => i.setTitle("Link a note to this card…").setIcon("link").onClick(() => this.linkNote()));
      for (const f of this.plugin.manualNotes(ref)) {
        menu.addItem((i) => i.setTitle(`Unlink “${f.basename}”`).setIcon("unlink").onClick(() => void this.unlinkNote(f)));
      }
      menu.addItem((i) => i.setTitle("Open the card's source note").setIcon("file-search").onClick(() => void this.openNote(true)));
      menu.addItem((i) => i.setTitle("Card info").setIcon("info").onClick(() => this.cardInfo()));
      menu.addItem((i) => i.setTitle("Deck options").setIcon("settings").onClick(() => this.deckOptions()));
      menu.addItem((i) =>
        i
          .setTitle(this.autoAdvance ? "Stop Auto Advance" : "Auto Advance")
          .setIcon(this.autoAdvance ? "pause-circle" : "play-circle")
          .onClick(() => this.toggleAutoAdvance()),
      );
      menu.showAtPosition({ x: actions.getBoundingClientRect().right - 180, y: actions.getBoundingClientRect().bottom });
    });
    action("x", "Close", () => this.close());
    const preset = this.plugin.presetFor(ref.deck);
    if (preset.timer.show) this.startTimer(top.createSpan({ cls: "fc-timer" }), preset.timer.maxAnswerSecs);
    this.scheduleAutoAdvance(preset);

    const card = el.createDiv({ cls: `fc-card ${flag ? `fc-flag-${flag}` : ""}` });
    card.style.fontSize = `${this.plugin.settings.fontSize}px`;
    applyCardTheme(this.app, el, card, this.plugin.settings);
    if (faces.kind === "occlusion" && ref.card.occlusion) {
      const occ = ref.card.occlusion;
      if (occ.header) this.md(occ.header, card.createDiv({ cls: "fc-question markdown-rendered" }));
      const active = masksForSlot(occ, ref.slot);
      renderFigure(this.app, card, occ, ref.path, {
        active,
        phase: this.phase === "back" ? "back" : "front",
        showAll: this.showAllMasks,
        // On the front a tap reveals the answer (spec 0003 §1.3); zoom is on the back.
        zoomable: this.phase === "back",
      });
      if (this.phase === "back") {
        const backEl = card.createDiv({ cls: "fc-back markdown-rendered" });
        const labels = active.map((id) => occ.masks.find((m) => m.id === id)?.label).filter(Boolean);
        if (labels.length) backEl.createDiv({ cls: "fc-io-label", text: labels.join(", ") });
        const toggle = backEl.createEl("button", { text: this.showAllMasks ? "Hide other masks (T)" : "Toggle masks (T)", cls: "fc-io-toggle" });
        toggle.onclick = (e) => {
          e.stopPropagation();
          this.toggleMasks();
        };
        if (faces.extra) this.md(faces.extra, backEl.createDiv({ cls: "fc-extra" }));
        this.relatedRow(backEl, ref);
      }
    }
    const question = faces.kind === "occlusion" ? null : card.createDiv({ cls: "fc-question markdown-rendered" });
    const showRevealedCloze = faces.kind === "cloze" && this.phase === "back";
    if (question) this.md(showRevealedCloze ? faces.answer : faces.question, question);

    if (this.phase === "back" && faces.kind !== "occlusion") {
      const backEl = card.createDiv({ cls: "fc-back markdown-rendered" });
      if (faces.kind === "basic") {
        backEl.createEl("hr", { cls: "fc-answer-rule" });
        this.md(faces.answer, backEl.createDiv({ cls: "fc-answer" }));
      }
      if (faces.extra) this.md(faces.extra, backEl.createDiv({ cls: "fc-extra" }));
      // Figures from the card's note section, if the card has no picture of its own (0002 §5).
      const preset = this.plugin.presetFor(ref.deck);
      const ownImages = imageEmbeds(`${faces.question}\n${faces.answer}\n${faces.extra}`).length > 0;
      // Not for imported Anki notes: their "section" is a whole deck, so the figures would be
      // other cards' pictures.
      const imported = !!this.app.metadataCache.getCache(ref.path)?.frontmatter?.["anki-deck"];
      if (preset.sectionFigures && !imported && !ownImages && ref.card.sectionImages.length) {
        const figs = ref.card.sectionImages.slice(0, preset.maxFigures);
        if (figs.length) this.md(figs.join("\n\n"), backEl.createDiv({ cls: "fc-figures" }));
      }
      this.relatedRow(backEl, ref);
      // Like Anki, the back opens at the top of the card, where the answer is. (Scrolling to the
      // back section jumped past the answer on long cards with big pictures.)
      const toTop = () => {
        card.scrollTop = 0;
        el.scrollTop = 0;
      };
      toTop();
      window.requestAnimationFrame(toTop);
      if (question && this.isCrowned(ref)) {
        this.crownsPending = true;
        this.queuedReveals = 0;
        const renders = [...this.pendingRenders];
        void Promise.all(renders).then(() => {
          if (this.current === item && this.phase === "back") this.setupOneByOne(question, backEl);
        });
      }
    }
    if (this.phase === "front") {
      // Tap anywhere on the card (not on a link) to show the answer (spec 0003 §1.3).
      card.onclick = (e) => {
        trace("tap (front)");
        this.askMotionPermission();
        if ((e.target as HTMLElement).closest("a, button")) return;
        this.showBack();
      };
    } else if (Platform.isMobile && this.plugin.settings.tapToAnswer) {
      // AnkiMobile's tap zones: right third = Good, left third = Again, middle does nothing.
      card.onclick = (e) => {
        trace("tap (back)");
        this.askMotionPermission();
        const t = e.target as HTMLElement;
        if (t.closest("a, button, .fc-crown, .fc-term, [class*='fc-term'], .fc-io, input, textarea")) return;
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / Math.max(1, r.width);
        if (x > 2 / 3) {
          if (this.crowns?.answers.some((a) => a.hasClass("fc-crowned"))) this.revealNext();
          else void this.answer("good");
        } else if (x < 1 / 3) void this.answer("again");
      };
    }

    // Once the card's Markdown has rendered, let add-ons (and the term hover) decorate it.
    const side = this.phase === "back" ? "back" : "front";
    const renderedFor = this.current;
    void Promise.allSettled(this.pendingRenders).then(() => {
      if (this.current !== renderedFor || !card.isConnected) return;
      const ctx = { ref, state: item.state, side: side as "front" | "back", el: card };
      timed("decorate", () => this.plugin.api.decorate(ctx));
      this.plugin.api.emit(side === "back" ? "answerShown" : "cardShown", ctx);
    });

    trace("card body built");
    // Bottom: remaining counts, then Show Answer or the four buttons.
    const bottom = el.createDiv({ cls: "fc-bottom" });
    if (Platform.isMobile) {
      this.clearNavbar();
      window.requestAnimationFrame(() => this.clearNavbar());
    }
    trace("bottom bar");
    if (this.plugin.settings.showRemaining) {
      const q = this.queue();
      const c = counts(q);
      const which = whichCount(item);
      const line = bottom.createDiv({ cls: "fc-remaining" });
      const part = (n: number, cls: string, active: boolean) =>
        line.createSpan({ text: String(n), cls: `${cls} ${active ? "fc-active" : ""}` });
      part(c.fresh, "fc-new", which === "fresh");
      line.appendText(" + ");
      part(c.learning, "fc-learn", which === "learning");
      line.appendText(" + ");
      part(c.review, "fc-due", which === "review");
    }
    const buttons = bottom.createDiv({ cls: "fc-buttons" });
    if (this.phase === "front") {
      const show = buttons.createEl("button", { text: "Show Answer", cls: "fc-show-answer" });
      show.onclick = () => {
        trace("Show Answer button");
        this.showBack();
      };
    } else {
      const now = new Date();
      const state = item.state?.card ?? newCard(now);
      const due = previewDue(this.plugin.schedulerFor(item.ref), state, now);
      for (const r of RATINGS) {
        const b = buttons.createEl("button", { cls: `fc-answer-btn fc-${r}` });
        if (this.plugin.settings.showIntervals) {
          b.createDiv({ cls: "fc-interval", text: formatInterval(due[r].getTime() - now.getTime()) });
        }
        b.createDiv({ text: LABEL[r] });
        b.onclick = () => void this.answer(r);
      }
    }
  }

  private pendingRenders: Promise<void>[] = [];

  // ---- phone: floating navbar, shake to undo (spec 0003 §1.3, AnkiMobile) ------------------

  /** Keep the answer buttons above Obsidian's floating bottom bar on the phone. */
  private clearNavbar(): void {
    const bar = document.querySelector<HTMLElement>(".mobile-navbar");
    let clear = 0;
    if (bar && bar.offsetParent !== null) {
      const r = bar.getBoundingClientRect();
      const mine = this.contentEl.getBoundingClientRect();
      if (r.height > 0 && r.top < mine.bottom) clear = Math.ceil(mine.bottom - r.top) + 4;
    }
    this.contentEl.style.setProperty("--fc-navbar-clearance", `${clear}px`);
  }

  private motionAsked = false;
  private lastShake = 0;
  private shakePeaks: number[] = [];

  /** iOS only lets a page read motion after a tap: ask once, on the first tap on a card. */
  private askMotionPermission(): void {
    if (this.motionAsked || !Platform.isMobile || !this.plugin.settings.shakeToUndo) return;
    this.motionAsked = true;
    const DME = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    if (DME?.requestPermission) {
      trace("motion permission: asking");
      void DME.requestPermission().then(
        (r) => trace(`motion permission: ${r}`),
        (e) => trace(`motion permission failed: ${String(e)}`),
      );
    }
  }

  /** Two strong jolts within a second = a shake (AnkiMobile: shake to undo). */
  private onMotion(e: DeviceMotionEvent): void {
    if (!this.plugin.settings.shakeToUndo || !this.contentEl.isShown()) return;
    const a = e.acceleration ?? e.accelerationIncludingGravity;
    if (!a) return;
    const g = e.acceleration ? 0 : 9.81;
    const mag = Math.abs(Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0) - g);
    const now = Date.now();
    if (mag < 14) return;
    this.shakePeaks = this.shakePeaks.filter((t) => now - t < 1000);
    if (this.shakePeaks.length && now - this.shakePeaks[this.shakePeaks.length - 1] < 120) return; // same jolt
    this.shakePeaks.push(now);
    if (this.shakePeaks.length >= 2 && now - this.lastShake > 1500) {
      this.lastShake = now;
      this.shakePeaks = [];
      if (this.undoStack.length) {
        new Notice("Undone.");
        void this.undo();
      }
    }
  }

  // ---- leeches, answer timer, auto advance (Anki's deck options, spec 0009) ------------------

  /** Anki: a card is a leech at N lapses, and again every N/2 lapses after that. */
  private async checkLeech(key: string, deck: string): Promise<string | undefined> {
    const p = this.plugin.presetFor(deck);
    const n = p.leechThreshold;
    const lapses = this.plugin.state.get(key)?.card.lapses ?? 0;
    if (n <= 0 || lapses < n || (lapses - n) % Math.max(1, Math.ceil(n / 2)) !== 0) return undefined;
    const ts = new Date(Date.now() + 1).toISOString();
    if (p.leechAction === "suspend") {
      await this.plugin.logEvent({ ts, type: "suspend", key });
      new Notice("Card was a leech and has been suspended. Fix it on the Leeches screen (deck list).");
    } else {
      await this.plugin.logEvent({ ts, type: "mark", key, marked: true });
      new Notice("Card was a leech and has been marked (★). Fix it on the Leeches screen (deck list).");
    }
    return ts;
  }

  private timerId = 0;

  private startTimer(el: HTMLElement, maxSecs: number): void {
    window.clearInterval(this.timerId);
    const tick = () => {
      if (!el.isConnected) return window.clearInterval(this.timerId);
      const secs = Math.min(maxSecs, Math.floor((Date.now() - this.shownAt) / 1000));
      el.setText(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`);
      el.toggleClass("fc-timer-max", secs >= maxSecs);
    };
    tick();
    this.timerId = window.setInterval(tick, 1000);
  }

  /** Auto Advance (Anki: started from the More menu), using the deck's seconds and action. */
  private autoAdvance = false;
  private autoTimer = 0;

  private toggleAutoAdvance(): void {
    const p = this.current ? this.plugin.presetFor(this.current.ref.deck) : this.plugin.presetFor(this.deck);
    if (!this.autoAdvance && !p.autoAdvance.questionSecs && !p.autoAdvance.answerSecs) {
      new Notice("Set the Auto Advance seconds in Deck options first.");
      return;
    }
    this.autoAdvance = !this.autoAdvance;
    new Notice(this.autoAdvance ? "Auto Advance started." : "Auto Advance stopped.");
    this.renderCard();
  }

  private scheduleAutoAdvance(p: Preset): void {
    window.clearTimeout(this.autoTimer);
    if (!this.autoAdvance) return;
    const item = this.current;
    const phase = this.phase;
    const secs = phase === "front" ? p.autoAdvance.questionSecs : p.autoAdvance.answerSecs;
    if (!secs) return;
    this.autoTimer = window.setTimeout(() => {
      if (this.current !== item || this.phase !== phase || !this.autoAdvance) return;
      if (phase === "front") this.showBack();
      else if (p.autoAdvance.answerAction === "bury") void this.hide("bury");
      else void this.answer(p.autoAdvance.answerAction);
    }, secs * 1000);
  }

  // ---- one by one (Anki's crown cards) -------------------------------------------------------

  /** The answers of the current back while they're being revealed one at a time. */
  private crowns?: { answers: HTMLElement[]; crowns: HTMLElement[]; later: HTMLElement[]; bar: HTMLElement };
  /** A crown card whose crowns are still being drawn, and N / Space presses made meanwhile. */
  private crownsPending = false;
  private queuedReveals = 0;

  private isCrowned(ref: CardRef): boolean {
    return this.plugin.isCrowned(ref);
  }

  /** The crown button: switch this card between one-by-one and all-at-once (kept per card). */
  private async toggleCrown(): Promise<void> {
    const item = this.current;
    if (!item || item.ref.card.type !== "cloze") return;
    const on = !this.isCrowned(item.ref);
    await this.plugin.setCrowns([item.ref], on);
    if (this.current !== item) return;
    new Notice(on ? "Answers now reveal one by one." : "Answers now show all at once.");
    // Crowns open on the back; turning them off shows the back with everything revealed.
    this.phase = "back";
    this.renderCard();
  }

  private setupOneByOne(question: HTMLElement, backEl: HTMLElement): void {
    // The revealed answers are the <mark>s of the back's cloze text.
    const answers = Array.from(question.querySelectorAll<HTMLElement>("mark.fc-answer"));
    if (answers.length === 0) return;
    const crowns = answers.map((m, i) => {
      const crown = createSpan({ cls: "fc-crown", text: "🦴", attr: { "aria-label": "Reveal this answer", role: "button" } });
      crown.onclick = (e) => {
        e.stopPropagation();
        this.revealCrown(i);
      };
      m.before(crown);
      m.addClass("fc-crowned");
      return crown;
    });
    // Like Anki, the Extra (and figures) wait until every answer is out. So does the Related row:
    // a note's title is often one of the answers.
    const later = Array.from(backEl.querySelectorAll<HTMLElement>(".fc-extra, .fc-figures, .fc-related"));
    for (const l of later) l.addClass("fc-crown-later");
    const bar = backEl.createDiv({ cls: "fc-crown-bar" });
    backEl.prepend(bar);
    const next = bar.createEl("button", { text: "Reveal Next (N)" });
    next.onclick = (e) => {
      e.stopPropagation();
      this.revealNext();
    };
    const all = bar.createEl("button", { text: "Toggle All (,)" });
    all.onclick = (e) => {
      e.stopPropagation();
      this.toggleAllCrowns();
    };
    this.crowns = { answers, crowns, later, bar };
    this.crownsPending = false;
    for (; this.queuedReveals > 0; this.queuedReveals--) this.revealNext();
  }

  private revealCrown(i: number): void {
    const c = this.crowns;
    if (!c) return;
    c.answers[i].removeClass("fc-crowned");
    c.crowns[i].addClass("fc-crown-gone");
    if (c.answers.every((a) => !a.hasClass("fc-crowned"))) for (const l of c.later) l.removeClass("fc-crown-later");
  }

  private revealNext(): void {
    const c = this.crowns;
    if (!c) return;
    const i = c.answers.findIndex((a) => a.hasClass("fc-crowned"));
    if (i >= 0) this.revealCrown(i);
  }

  private toggleAllCrowns(): void {
    const c = this.crowns;
    if (!c) return;
    const anyHidden = c.answers.some((a) => a.hasClass("fc-crowned"));
    c.answers.forEach((a, i) => {
      a.toggleClass("fc-crowned", !anyHidden);
      c.crowns[i].toggleClass("fc-crown-gone", anyHidden);
    });
    for (const l of c.later) l.toggleClass("fc-crown-later", !anyHidden);
  }

  private md(markdown: string, el: HTMLElement): void {
    const n = this.pendingRenders.length;
    trace(`md render #${n} (${markdown.length} chars)`);
    this.pendingRenders.push(
      MarkdownRenderer.render(this.app, markdown, el, this.current?.ref.path ?? "", this.cardComponent!).then(() => trace(`md render #${n} done`)),
    );
  }

  // ---- actions ---------------------------------------------------------------------------

  private async answer(rating: RatingName): Promise<void> {
    trace(`answer ${rating} (phase ${this.phase}, busy ${this.busy})`);
    if (this.phase !== "back" || !this.current || this.busy) return;
    this.busy = true;
    try {
      const item = this.current;
      const def = this.filteredDef();
      if (def && !def.reschedule) {
        // Preview/cram: nothing is recorded. Again sends the card to the back of the session.
        const id = item.ref.key ?? item.ref.uid;
        if (rating === "again") {
          const order = (this.previewOrder ?? def.cards ?? []).filter((x) => x !== id);
          this.previewOrder = [...order, id];
        } else this.previewDone.add(id);
        this.answered++;
        this.current = undefined;
        this.showFront();
        return;
      }
      const oldUid = item.ref.uid;
      const key = await this.plugin.ensureKey(item.ref);
      trace(`ensureKey -> ${key}`);
      if (def && key && oldUid !== key) await this.plugin.renameFilteredCard(oldUid, key);
      if (!key) {
        new Notice("This card changed in its note since it was shown. It will come back once the note is re-read.");
        this.current = undefined;
        this.showFront();
        return;
      }
      const now = new Date();
      const ts = now.toISOString();
      const maxMs = Math.max(1, this.plugin.presetFor(item.ref.deck).timer.maxAnswerSecs) * 1000;
      const ms = Math.min(now.getTime() - this.shownAt, maxMs);
      // Don't wait for the disk write: state is already updated, so the next card can show now.
      void this.plugin.logEvent({ ts, type: "review", key, rating, ms, hash: item.ref.card.hash }).catch(() => undefined);
      this.plugin.api.emit("answer", item.ref, rating);
      // Undoing this answer must also take back the suspend/mark it caused.
      const leechTs = rating === "again" ? await this.checkLeech(key, item.ref.deck) : undefined;
      this.undoStack.push({ key, ts, leechTs });
      this.answered++;
      this.current = undefined;
      this.showFront();
    } finally {
      this.busy = false;
    }
  }

  private async undo(): Promise<void> {
    if (this.busy || this.undoStack.length === 0) return;
    this.busy = true;
    try {
      const last = this.undoStack.pop()!;
      const now = Date.now();
      // Two undo lines for one card need different timestamps (events are identified by them).
      if (last.leechTs) await this.plugin.logEvent({ ts: new Date(now - 1).toISOString(), type: "undo", key: last.key, target: last.leechTs });
      await this.plugin.logEvent({ ts: new Date(now).toISOString(), type: "undo", key: last.key, target: last.ts });
      this.answered = Math.max(0, this.answered - 1);
      const ref = this.plugin.index.refs().find((r) => r.key === last.key);
      if (ref) this.showFront({ ref, state: this.plugin.state.get(last.key) });
      else this.showFront();
    } finally {
      this.busy = false;
    }
  }

  private toggleMasks(): void {
    if (this.phase !== "back" || this.current?.ref.card.type !== "occlusion") return;
    this.showAllMasks = !this.showAllMasks;
    this.renderCard();
  }

  private editCard(): void {
    const item = this.current;
    if (!item) return;
    const afterEdit = () => {
      // Find the edited card again (its lines may have moved) and redraw it.
      const { key, path, card, slot } = item.ref;
      const refs = this.plugin.index.refs();
      const ref =
        (key && refs.find((r) => r.key === key)) ||
        refs.find((r) => r.path === path && r.card.startLine === card.startLine && r.slot === slot) ||
        refs.find((r) => r.path === path && r.card.startLine === card.startLine);
      if (!ref) {
        this.current = undefined;
        this.showFront();
        return;
      }
      this.current = { ref, state: ref.key ? this.plugin.state.get(ref.key) : undefined };
      this.renderCard();
    };
    const { card } = item.ref;
    if (card.type === "occlusion" && card.occlusion) {
      this.plugin.editOcclusion(item.ref.path, card.startLine, card.sourceLines, card.occlusion, afterEdit);
    } else {
      new EditCardModal(this.app, this.plugin, item.ref, afterEdit).open();
    }
  }

  private async setFlag(flag: number): Promise<void> {
    const item = this.current;
    if (!item || this.busy) return;
    const key = await this.plugin.ensureKey(item.ref);
    if (!key) return;
    const next = (item.state?.flag ?? 0) === flag ? 0 : flag;
    await this.plugin.logEvent({ ts: new Date().toISOString(), type: "flag", key, flag: next });
    this.refreshCurrent(key);
  }

  private async toggleMark(): Promise<void> {
    const item = this.current;
    if (!item || this.busy) return;
    const key = await this.plugin.ensureKey(item.ref);
    if (!key) return;
    await this.plugin.logEvent({ ts: new Date().toISOString(), type: "mark", key, marked: !(item.state?.marked ?? false) });
    this.refreshCurrent(key);
  }

  /** Redraw the current card with its latest state (after a flag, mark or reschedule). */
  private refreshCurrent(key: string): void {
    const ref = this.plugin.index.refs().find((r) => r.key === key) ?? this.current?.ref;
    if (!ref) return;
    this.current = { ref, state: this.plugin.state.get(key) };
    this.renderCard();
  }

  private setDue(): void {
    const item = this.current;
    if (!item) return;
    new SetDueModal(this.app, this.plugin, [item.ref], () => {
      this.current = undefined;
      this.showFront();
    }).open();
  }

  private cardInfo(): void {
    const item = this.current;
    if (!item) return;
    new CardInfoModal(this.app, this.plugin, item.ref, item.ref.key ? this.plugin.state.get(item.ref.key) : item.state).open();
  }

  private deckOptions(): void {
    new DeckOptionsModal(this.app, this.plugin, this.current?.ref.deck ?? this.deck).open();
  }

  private async hide(type: "bury" | "suspend"): Promise<void> {
    if (!this.current || this.busy) return;
    this.busy = true;
    try {
      const key = await this.plugin.ensureKey(this.current.ref);
      if (!key) return;
      const ts = new Date().toISOString();
      await this.plugin.logEvent({ ts, type, key });
      this.undoStack.push({ key, ts });
      new Notice(type === "bury" ? "Card buried until tomorrow." : "Card suspended.");
      this.current = undefined;
      this.showFront();
    } finally {
      this.busy = false;
    }
  }

  /** "Related: A · B": study notes the card mentions by title or alias (N opens the first). */
  private relatedRow(backEl: HTMLElement, ref: CardRef): void {
    const related = this.relatedFor(ref);
    if (!related.length) return;
    const row = backEl.createDiv({ cls: "fc-related" });
    row.createSpan({ cls: "fc-muted", text: "Related: " });
    related.forEach((f, i) => {
      if (i) row.appendText(" · ");
      const a = row.createEl("a", { text: f.basename, href: "#", cls: "fc-related-link" });
      a.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.openInSide(f);
      };
    });
  }

  private relatedFor(ref: CardRef): TFile[] {
    return this.plugin.relatedFor(ref);
  }

  private async openInSide(file: TFile, line?: number, endLine?: number): Promise<void> {
    const reuse = this.noteLeaf && this.app.workspace.getLeavesOfType("markdown").includes(this.noteLeaf);
    const leaf = reuse ? this.noteLeaf! : Platform.isMobile ? this.app.workspace.getLeaf("tab") : this.app.workspace.getLeaf("split");
    this.noteLeaf = leaf;
    await leaf.openFile(file, line === undefined ? undefined : { eState: { line } });
    const view = leaf.view;
    if (line !== undefined && view instanceof MarkdownView) {
      view.editor.setCursor({ line, ch: 0 });
      view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line: endLine ?? line, ch: 0 } }, true);
    }
  }

  /**
   * N: the card's own note. For cards imported from Anki (their note is just card storage), its
   * linked study note (spec 0011), else the most specific related one, so N means "learn more".
   */
  /** Pick a note to tie to this card; N opens it from then on and it leads the Related row. */
  private linkNote(): void {
    const ref = this.current?.ref;
    if (!ref) return;
    const text = [ref.card.front, ref.card.answer, ref.card.back, ref.card.occlusion?.header ?? ""].join("\n");
    const linked = new Set(this.plugin.manualNotes(ref).map((f) => f.path));
    const suggested = [...new Set([...this.plugin.relatedFor(ref), ...this.plugin.noteMatches(text, 8)])].filter((f) => f.path !== ref.path && !linked.has(f.path));
    new NotePicker(this.plugin, suggested, async (file) => {
      if (await this.plugin.linkNote(ref, file)) {
        new Notice(`Linked “${file.basename}”. N opens it from this card.`);
        this.renderCard();
      } else new Notice("Couldn't link a note to this card.");
    }).open();
  }

  private async unlinkNote(file: TFile): Promise<void> {
    const ref = this.current?.ref;
    if (!ref) return;
    await this.plugin.unlinkNote(ref, file.path);
    new Notice(`Unlinked “${file.basename}”.`);
    this.renderCard();
  }

  /** The card on screen and which side is showing (for the AI helper panel). */
  context(): { ref: CardRef; side: "front" | "back" } | null {
    if (!this.current || (this.phase !== "front" && this.phase !== "back")) return null;
    return { ref: this.current.ref, side: this.phase };
  }

  private async openNote(source = false): Promise<void> {
    const ref = this.current?.ref;
    if (!ref) return;
    const file = this.app.vault.getFileByPath(ref.path);
    if (!file) return;
    if (!source) {
      // A note the student linked to this card wins, whatever kind of card it is.
      const linked = this.plugin.manualNotes(ref)[0];
      if (linked) return this.openInSide(linked);
      if (this.app.metadataCache.getFileCache(file)?.frontmatter?.["anki-deck"]) {
        const related = this.relatedFor(ref)[0];
        if (related) return this.openInSide(related);
        new Notice("No note of yours matches this card. Link one with ⋯ → Link a note to this card. Opening the imported deck's card file.", 8000);
      }
    }
    return this.openInSide(file, ref.card.startLine, ref.card.endLine);
  }

  private close(): void {
    this.cardComponent?.unload();
    this.cardComponent = undefined;
    this.phase = "overview";
    this.current = undefined;
    this.render();
  }

  /**
   * D (and the controller's "Go to decks"): leave the reviewer for the deck list, as Anki does, so
   * the review tab doesn't linger. An open deck tab is revealed and this one closed; otherwise this
   * tab becomes the deck list.
   */
  private async backToDecks(): Promise<void> {
    if (this.app.workspace.getLeavesOfType(VIEW_DECKS).length) {
      await this.plugin.openDecks();
      this.leaf.detach();
    } else {
      await this.leaf.setViewState({ type: VIEW_DECKS, active: true, state: {} });
    }
  }

  /** Anki's main-window keys, available from any review screen: D decks, B browse, A add. */
  private globalKey(is: (a: ActionName) => boolean): boolean {
    if (is("customStudy") && this.phase === "overview" && !this.filtered) new CustomStudyModal(this.app, this.plugin, this.deck).open();
    else if (is("decks")) void this.backToDecks();
    else if (is("browse")) void this.plugin.openBrowse();
    else if (is("addCard")) this.plugin.openAddCard(this.current?.ref.deck ?? this.deck);
    else return false;
    return true;
  }

  /** Returns true if the key was handled (Obsidian then prevents its default action). */
  private onKey(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, [contenteditable=true]")) return false;
    const pressed = keyString(e);
    const keys = this.plugin.settings.keys;
    const is = (a: ActionName) => keys[a].includes(pressed);
    // A held key auto-repeats: without this, holding Space would reveal and then rate Good.
    if (e.repeat) return Object.values(keys).some((k) => k.includes(pressed));
    let handled = true;

    if (this.phase === "overview") {
      if (is("showAnswer") || pressed === "s") this.start();
      else handled = this.globalKey(is);
    } else if (this.phase === "back" && this.crownsPending && (is("revealNext") || is("showAnswer"))) {
      this.queuedReveals++;
    } else if (this.phase === "back" && this.crowns && is("revealNext") && this.crowns.answers.some((a) => a.hasClass("fc-crowned"))) {
      // On a crown card N means Reveal Next (as in Anki), even though N also opens the note.
      this.revealNext();
    } else if (this.phase === "front" || this.phase === "back") {
      const rating = this.phase === "back" ? RATINGS.find((r) => is(r)) : undefined;
      const flagN = ([1, 2, 3, 4, 5, 6, 7] as const).find((n) => is(`flag${n}` as ActionName));
      if (rating) void this.answer(rating);
      else if (is("showAnswer")) {
        if (this.phase === "front") this.showBack();
        // Crowns still hidden: Space reveals the next answer rather than grading unseen ones.
        else if (this.crowns?.answers.some((a) => a.hasClass("fc-crowned"))) this.revealNext();
        else void this.answer("good");
      } else if (is("undo")) void this.undo();
      else if (is("editCard")) this.editCard();
      else if (is("openNote")) void this.openNote();
      else if (is("aiHelper") && this.plugin.settings.ai.enabled) void this.plugin.openAssistant();
      else if (is("mark")) void this.toggleMark();
      else if (is("toggleMasks") && this.phase === "back" && this.current?.ref.card.type === "occlusion") this.toggleMasks();
      else if (is("revealNext") && this.crowns) this.revealNext();
      else if (is("revealAll") && this.crowns) this.toggleAllCrowns();
      else if (flagN) void this.setFlag(flagN);
      else if (is("bury")) void this.hide("bury");
      else if (is("suspend")) void this.hide("suspend");
      else if (is("setDue")) this.setDue();
      else if (is("cardInfo")) this.cardInfo();
      else if (is("deckOptions")) this.deckOptions();
      else if (is("close")) this.close();
      else handled = this.globalKey(is);
    } else {
      if (is("undo")) void this.undo();
      else if (is("close")) this.close();
      else handled = this.globalKey(is);
    }
    return handled;
  }
}

interface NotePick {
  file: TFile;
  /** A line under the title: why this note is offered. */
  detail?: string;
}

/** What the Omnisearch plugin offers other plugins (https://publish.obsidian.md/omnisearch). */
interface Omnisearch {
  search(query: string): Promise<Array<{ path: string; foundWords: string[]; excerpt: string }>>;
}

/**
 * Choose a note to link to a card. Before anything is typed it offers the notes that look related to
 * the card. Typing searches inside the notes with Omnisearch when that plugin is installed, and
 * otherwise titles, aliases and headings with the plugin's own search.
 */
class NotePicker extends SuggestModal<NotePick> {
  private notes?: SearchableNote[];

  constructor(
    private plugin: FlashcardsPlugin,
    private suggested: TFile[],
    private onPick: (file: TFile) => void | Promise<void>,
  ) {
    super(plugin.app);
    this.limit = 30;
    this.setPlaceholder("Link which note to this card? Type to search");
    this.emptyStateText = "No note found.";
    this.setInstructions([{ command: "", purpose: this.omnisearch() ? "Searching inside your notes with Omnisearch" : "Searching titles and headings" }]);
  }

  private omnisearch(): Omnisearch | undefined {
    const o = (globalThis as { omnisearch?: Omnisearch }).omnisearch;
    return typeof o?.search === "function" ? o : undefined;
  }

  /** The student's own notes: not imported decks, not the plugin's data. */
  private own(file: TFile): boolean {
    if (file.extension !== "md" || file.path.startsWith(this.plugin.settings.stateFolder + "/")) return false;
    return !this.app.metadataCache.getFileCache(file)?.frontmatter?.["anki-deck"];
  }

  async getSuggestions(query: string): Promise<NotePick[]> {
    const q = query.trim();
    if (!q) return this.suggested.map((file) => ({ file, detail: "Looks related to this card" }));
    const omni = this.omnisearch();
    if (omni) {
      try {
        const out: NotePick[] = [];
        for (const r of await omni.search(q)) {
          const file = this.app.vault.getFileByPath(r.path);
          if (!file || !this.own(file)) continue;
          const line = excerptLine(r.excerpt, r.foundWords);
          out.push({ file, detail: line && line.toLowerCase() !== file.basename.toLowerCase() ? line : undefined });
        }
        if (out.length) return out.slice(0, this.limit);
      } catch {
        // Omnisearch still indexing, or changed: fall through to the plugin's own search.
      }
    }
    this.notes ??= this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.own(f))
      .map((f) => {
        const cache = this.app.metadataCache.getFileCache(f);
        const aliases: unknown = cache?.frontmatter?.aliases ?? cache?.frontmatter?.alias ?? [];
        const names = [f.basename, ...(Array.isArray(aliases) ? aliases : [aliases]).filter((x): x is string => typeof x === "string")];
        return { path: f.path, names, headings: (cache?.headings ?? []).map((h) => h.heading) };
      });
    const hits = searchNotes(q, this.notes, this.limit);
    if (hits.length) {
      return hits.flatMap((h) => {
        const file = this.app.vault.getFileByPath(h.path);
        return file ? [{ file, detail: h.heading ? `Section: ${h.heading}` : undefined }] : [];
      });
    }
    // Nothing word for word: loose letter matching on the title, so a typo still finds the note.
    const fuzzy = prepareFuzzySearch(q);
    return this.notes
      .map((n) => ({ n, m: fuzzy(n.names[0]) }))
      .filter((x) => x.m)
      .sort((x, y) => y.m!.score - x.m!.score)
      .slice(0, this.limit)
      .flatMap((x) => {
        const file = this.app.vault.getFileByPath(x.n.path);
        return file ? [{ file }] : [];
      });
  }

  renderSuggestion(pick: NotePick, el: HTMLElement): void {
    el.addClass("fc-notepick");
    const top = el.createDiv({ cls: "fc-notepick-top" });
    top.createSpan({ cls: "fc-notepick-title", text: pick.file.basename });
    const folder = pick.file.parent?.path ?? "";
    if (folder && folder !== "/") top.createSpan({ cls: "fc-notepick-folder", text: folder });
    if (pick.detail) el.createDiv({ cls: "fc-notepick-detail", text: pick.detail });
  }

  onChooseSuggestion(pick: NotePick): void {
    void this.onPick(pick.file);
  }
}
