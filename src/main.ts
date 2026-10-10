import { debounce, Editor, Events, normalizePath, Notice, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import type { FSRS } from "ts-fsrs";
import { addRename, findClozeAlias, hiddenFrom, inDeck, moveDeckKey, slotsById, slotsWithHistory, type CardRef } from "./core/collection";
import { insertCardId, newCardId, replaceCardSource } from "./core/ids";
import type { LogEvent } from "./core/log";
import { OCCLUSION_LANG, parseOcclusion, serializeOcclusion, type Occlusion } from "./core/occlusion";
import { imageEmbeds } from "./core/parser";
import { OcclusionEditorModal } from "./plugin/modals/occlusion-editor";
import { renderFigure } from "./plugin/occlusion-render";
import { buildQueue, todayStats, type Queue, type QueueItem, type TodayStats } from "./core/queue";
import { presetIdFor, type Preset } from "./core/presets";
import { buildFiltered, filteredQueue, type FilteredDeck } from "./core/filtered";
import { dayStart } from "./core/day";
import { makeScheduler } from "./core/scheduler";
import type { SearchContext } from "./core/search";
import { crownSplit, revealsOneByOne, type CrownSplit } from "./core/faces";
import { ReviewState } from "./core/state";
import { AiService } from "./plugin/ai";
import { GamepadService } from "./plugin/gamepad";
import { ExamService } from "./plugin/exams";
import { LinkService } from "./plugin/links";
import { ExamImportModal } from "./plugin/modals/exam-import";
import { MissesView, VIEW_MISSES } from "./plugin/views/misses";
import { LeechesView, VIEW_LEECHES } from "./plugin/views/leeches";
import { VIEW_WEAK, WeakView } from "./plugin/views/weak";
import { probeDownloads, samplePaths } from "./plugin/downloads";
import { AssistantView, VIEW_AI } from "./plugin/views/assistant";
import { NoteMatcher, type TitledNote } from "./core/note-match";
import { findLeeches } from "./core/leeches";
import { weakCards, type WeakCard } from "./core/weak";
import { pickAndImportApkg } from "./plugin/anki-import";
import { AnkiMediaModal } from "./plugin/anki-media";
import { FlashcardsApi } from "./plugin/api";
import { TermService } from "./plugin/hover";
import { CardIndex } from "./plugin/indexer";
import { ensureImportBaseline } from "./plugin/import-sources";
import { deviceId, LogStore, type DeviceInfo } from "./plugin/logstore";
import { startTrace, trace } from "./plugin/trace";
import { FlashcardsSettingTab, mergeSettings, type FlashcardsSettings } from "./plugin/settings";
import { AddCardModal } from "./plugin/modals/add-card";
import { CustomStudyModal, FilteredDeckModal } from "./plugin/modals/filtered";
import { MigrateModal, RewriteListModal } from "./plugin/modals/migrate";
import { BrowseView, VIEW_BROWSE } from "./plugin/views/browse";
import { DeckView, VIEW_DECKS } from "./plugin/views/decks";
import { ReviewView, VIEW_REVIEW } from "./plugin/views/review";
import { StatsView, VIEW_STATS } from "./plugin/views/stats";

export default class FlashcardsPlugin extends Plugin {
  settings!: FlashcardsSettings;
  index!: CardIndex;
  logs!: LogStore;
  state!: ReviewState;
  /** The add-on API (spec 0005 §1): app.plugins.getPlugin("osteon").api */
  api!: FlashcardsApi;
  terms!: TermService;
  ai!: AiService;
  gamepad!: GamepadService;
  links!: LinkService;
  exams!: ExamService;
  /** What `note:` and `missed:` searches need: linked notes (spec 0011) and exam misses (spec 0012). */
  searchCtx: SearchContext = {
    linked: (ref: CardRef) => this.links?.notesFor(ref) ?? [],
    missed: (path: string) => this.exams?.missed(path) ?? 0,
    crown: (ref: CardRef) => (this.crownOverride(ref) === undefined ? (this.isCrowned(ref) ? "auto" : "none") : this.isCrowned(ref) ? "on" : "off"),
  };

  // ---- crown cards (👑 one-by-one reveal), switchable per card --------------------------
  /** Cards that got their ID from a crown switch, until the index re-reads them. */
  private newCrownKeys = new Map<string, string>();

  private crownKey(ref: CardRef): string | undefined {
    return ref.card.id ? `${ref.card.id}.${ref.slot}` : this.newCrownKeys.get(ref.uid);
  }

  /** The card's hand-set crown switch (undefined = the automatic rule). */
  crownOverride(ref: CardRef): boolean | undefined {
    const key = this.crownKey(ref);
    return key === undefined ? undefined : this.settings.crownOverrides[key];
  }

  isCrowned(ref: CardRef): boolean {
    return ref.card.type !== "occlusion" && revealsOneByOne(ref.card, ref.slot, this.settings.oneByOneMin, this.crownOverride(ref));
  }

  crownSplitFor(ref: CardRef): CrownSplit {
    return crownSplit(ref.card, ref.slot, this.settings.oneByOneMin, this.crownOverride(ref));
  }

  /**
   * Switch cards to crowns (true), away from them (false), or back to the automatic rule
   * (undefined). Only differences from the rule are stored. Returns how many cards changed.
   */
  async setCrowns(refs: CardRef[], on: boolean | undefined): Promise<number> {
    let n = 0;
    // Bottom-up within a note, so a written ID can't shift the cards below it.
    const ordered = refs
      .filter((r) => r.card.type === "cloze")
      .sort((a, b) => a.path.localeCompare(b.path) || b.card.startLine - a.card.startLine);
    for (const ref of ordered) {
      const key = this.crownKey(ref) ?? (on === undefined ? null : await this.ensureKey(ref));
      if (!key) continue;
      if (!ref.card.id) this.newCrownKeys.set(ref.uid, key);
      const auto = revealsOneByOne(ref.card, ref.slot, this.settings.oneByOneMin);
      const before = this.settings.crownOverrides[key];
      if (on === undefined || on === auto) delete this.settings.crownOverrides[key];
      else this.settings.crownOverrides[key] = on;
      if (this.settings.crownOverrides[key] !== before) n++;
    }
    await this.saveSettings();
    this.invalidateItems();
    this.events.trigger("changed");
    return n;
  }
  /** Fires "changed" whenever cards or review state change (and drops the cached queue items first). */
  events = (() => {
    const ev = new Events();
    const trigger = ev.trigger.bind(ev);
    ev.trigger = (name: string, ...data: unknown[]) => {
      if (name === "changed") this.invalidateItems();
      trigger(name, ...data);
    };
    return ev;
  })();
  ready = false;
  /** One FSRS instance per deck-options preset. */
  private fsrsByPreset = new Map<string, FSRS>();
  /** Card ID → preset ID, from the cards' decks. */
  private cardPreset = new Map<string, string>();

  async onload(): Promise<void> {
    await startTrace(this.app, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`, deviceId(this.app), this.manifest.version, (cb) => this.register(cb));
    trace("onload");
    this.settings = mergeSettings(await this.loadData());
    this.makeSchedulers();
    this.state = new ReviewState(this.replayOptions());
    this.logs = new LogStore(this.app, () => this.settings.stateFolder, deviceId(this.app), this.manifest.version);
    this.index = new CardIndex(this.app, () => this.settings);
    this.api = new FlashcardsApi(this);
    this.terms = new TermService(this);
    this.ai = new AiService(this);
    this.gamepad = new GamepadService(this);
    this.gamepad.start();
    this.links = new LinkService(this);
    this.exams = new ExamService(this);
    // The term hover is built on the add-on API, like any add-on would be.
    this.api.registerReviewDecorator((ctx) => {
      if (ctx.side === "front" && !this.settings.hover.onFront) return;
      this.terms.decorate(ctx.el, ctx.ref.path);
    });
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (!this.settings.hover.inNotes || this.settings.hover.sensitivity === "off") return;
      // Only notes: cards in the reviewer are decorated by the review decorator (which respects
      // "also on the front"), and popups/modals are left alone. Wait until el is attached.
      window.requestAnimationFrame(() => {
        if (!el.isConnected || el.closest(".fc-review, .fc-browse, .fc-term-popup, .modal")) return;
        this.terms.decorate(el, ctx.sourcePath);
      });
    });
    this.addCommand({ id: "open-my-terms", name: "Open My terms (definitions for the term hover)", callback: () => void this.terms.openMyTerms() });
    this.addCommand({ id: "ai-find-terms", name: "Find hard terms with AI now", callback: () => void this.ai.runWithConfirm() });

    this.registerView(VIEW_DECKS, (leaf) => new DeckView(leaf, this));
    this.registerView(VIEW_REVIEW, (leaf) => new ReviewView(leaf, this));
    this.registerView(VIEW_AI, (leaf) => new AssistantView(leaf, this));
    this.registerView(VIEW_BROWSE, (leaf) => new BrowseView(leaf, this));
    this.registerView(VIEW_STATS, (leaf) => new StatsView(leaf, this));
    this.registerView(VIEW_MISSES, (leaf) => new MissesView(leaf, this));
    this.registerView(VIEW_LEECHES, (leaf) => new LeechesView(leaf, this));
    this.registerView(VIEW_WEAK, (leaf) => new WeakView(leaf, this));
    this.addSettingTab(new FlashcardsSettingTab(this.app, this));

    this.addRibbonIcon("layers", "Osteon: decks", () => this.openDecks());
    this.addCommand({ id: "open-decks", name: "Open decks", callback: () => this.openDecks() });
    this.addCommand({ id: "study-all", name: "Study all decks", callback: () => this.openReview(null) });
    this.addCommand({ id: "browse", name: "Browse cards", callback: () => this.openBrowse() });
    this.addCommand({ id: "stats", name: "Statistics", callback: () => this.openStats(null) });
    this.addCommand({ id: "filtered-deck", name: "Create filtered deck", callback: () => new FilteredDeckModal(this.app, this).open() });
    this.addCommand({ id: "custom-study", name: "Custom study (all decks)", callback: () => new CustomStudyModal(this.app, this, null).open() });
    this.addCommand({ id: "add-card", name: "Add card", callback: () => this.openAddCard(null) });
    this.addCommand({ id: "import-exam", name: "Import exam results (missed questions)…", callback: () => new ExamImportModal(this.app, this).open() });
    this.addCommand({ id: "open-misses", name: "What I keep missing", callback: () => this.openMisses() });
    this.addCommand({ id: "ai-helper", name: "Open the AI helper (side panel)", callback: () => void this.openAssistant() });
    this.addCommand({ id: "open-leeches", name: "Leeches (cards I keep forgetting)", callback: () => this.openLeeches() });
    this.addCommand({ id: "open-weak", name: "Weak spots (cards and topics I missed most)", callback: () => this.openWeak() });
    this.addCommand({
      id: "reload-links",
      name: "Reload linked-note tables (*.cardlinks.json)",
      callback: async () => {
        await this.links.rebuild();
        await this.exams.load();
        new Notice(`${this.links.size.toLocaleString()} imported cards are linked to notes.`);
      },
    });
    this.addCommand({
      id: "study-note",
      name: "Study this note's cards (its own and linked ones)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.studyNote(file);
        return true;
      },
    });
    this.addCommand({ id: "import-apkg", name: "Import deck (.apkg)…", callback: () => pickAndImportApkg(this) });
    this.addCommand({ id: "copy-anki-media", name: "Copy deck pictures into the vault (desktop)…", callback: () => new AnkiMediaModal(this.app, this).open() });
    this.addCommand({ id: "migrate-sr", name: "Migrate from Spaced Repetition…", callback: () => new MigrateModal(this.app, this).open() });
    this.addCommand({ id: "rewrite-list", name: "Find cards to rewrite", callback: () => new RewriteListModal(this.app, this).open() });
    this.addCommand({
      id: "create-occlusion",
      name: "Create image occlusion from the image on this line",
      editorCheckCallback: (checking, editor, ctx) => {
        const lineNo = editor.getCursor().line;
        const embed = imageEmbeds(editor.getLine(lineNo))[0];
        if (!embed || !ctx.file) return false;
        if (!checking) this.createOcclusion(editor, ctx.file.path, lineNo, embed);
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const lineNo = editor.getCursor().line;
        const embed = imageEmbeds(editor.getLine(lineNo))[0];
        if (!embed || !info.file) return;
        const path = info.file.path;
        menu.addItem((i) => i.setTitle("Create image occlusion").setIcon("square-dashed").onClick(() => this.createOcclusion(editor, path, lineNo, embed)));
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((i) => i.setTitle("Study this note's cards").setIcon("layers").onClick(() => void this.studyNote(file)));
      }),
    );
    // Occlusion blocks show as the figure in notes, with faint outlines and an Edit button.
    this.registerMarkdownCodeBlockProcessor(OCCLUSION_LANG, (source, el, ctx) => {
      const occ = parseOcclusion(source);
      el.addClass("fc-io-block");
      renderFigure(this.app, el, occ, ctx.sourcePath, { active: [], phase: "note", zoomable: true });
      const bar = el.createDiv({ cls: "fc-io-block-bar" });
      bar.createSpan({ cls: "fc-muted", text: `${occ.masks.length} box${occ.masks.length === 1 ? "" : "es"} · ${occ.mode === "hide-all" ? "hide all" : "hide one"}` });
      const edit = bar.createEl("button", { text: "Edit occlusion" });
      edit.onclick = () => {
        const info = ctx.getSectionInfo(el);
        if (!info) {
          new Notice("Open the note in editing or reading view to edit this figure.");
          return;
        }
        const expected = info.text.split("\n").slice(info.lineStart, info.lineEnd + 1);
        this.editOcclusion(ctx.sourcePath, info.lineStart, expected, occ);
      };
    });

    // Linked notes only cover loaded cards, so a full rebuild (unhiding a deck, Show Hidden Decks,
    // an import) reloads them; at startup links are built right after the index anyway.
    this.index.on("built", () => {
      if (this.ready) this.links.rebuildSoon();
    });
    this.index.on("changed", () => {
      this.invalidateItems(); // before the debounced notify, so nothing reads a stale list meanwhile
      this.updateCardPresets();
      this.notify();
      this.checkAliases();
    });

    // obsidian://osteon opens the deck list; obsidian://osteon?study opens Study all (for Shortcuts).
    this.registerObsidianProtocolHandler("osteon", (params) => void ("study" in params ? this.openReview(null) : this.openDecks()));
    // Both events: opening a note that is already the active file fires no "file-open".
    this.registerEvent(this.app.workspace.on("file-open", (f) => void this.openHomeIfShortcut(f)));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => void this.openHomeIfShortcut(this.fileIn(leaf), leaf)));
    this.app.workspace.onLayoutReady(() => void this.openHomeIfShortcut(this.app.workspace.getActiveFile()));

    this.app.workspace.onLayoutReady(async () => {
      // Listen before the first scan so edits and log files that sync in during startup
      // (common on the iPhone) aren't missed.
      this.registerEvent(
        this.app.metadataCache.on("changed", (file, data, cache) => {
          if (this.logs.isLogFile(file.path)) return;
          this.index.onMetadataChanged(file, data, cache);
          // Aliases, My terms and AI glossary files feed the term hover (only those rebuild it).
          this.terms.onFileChanged(file.path);
        }),
      );
      // On a fresh device the metadata cache may still be filling at layout-ready; tags
      // (which decide what gets scanned) are only reliable once it has resolved.
      let rescanned = false;
      this.registerEvent(
        this.app.metadataCache.on("resolved", () => {
          if (rescanned || !this.ready) return;
          rescanned = true;
          void this.index.rescanIfChanged();
        }),
      );
      const onLogChange = (path: string) => {
        // Our own appends are already applied; only other devices' files need a reload.
        if (this.logs.isLogFile(path) && !this.logs.isOwn(path)) this.reloadLogsSoon();
        if (this.links.isSource(path)) this.links.rebuildSoon();
      };
      this.registerEvent(this.app.vault.on("modify", (f) => onLogChange(f.path)));
      this.registerEvent(
        this.app.vault.on("create", (f) => {
          onLogChange(f.path);
          if (f.path.endsWith(".md") && !this.logs.isLogFile(f.path)) this.terms.rebuildSoon();
        }),
      );
      this.registerEvent(
        this.app.vault.on("delete", (f) => {
          if (this.logs.isLogFile(f.path)) this.reloadLogsSoon();
          else if (this.links.isSource(f.path)) this.links.rebuildSoon();
          else {
            this.index.onDelete(f.path);
            if (f.path.endsWith(".md")) this.terms.rebuildSoon();
          }
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (f, oldPath) => {
          if (!(f instanceof TFile)) return;
          if (f.extension === "md") {
            void this.index.onRename(f, oldPath);
            void this.renameLinkedNote(oldPath, f.path);
            this.matcher = undefined;
            this.terms.rebuildSoon();
            this.links.rebuildSoon(); // tables name notes by path
          }
          else void this.relinkOcclusionImages(f, oldPath);
        }),
      );

      try {
        // Logs and cards don't depend on each other: read both at once (their file reads overlap,
        // which matters on the phone where each iCloud read waits).
        await Promise.all([
          this.reloadLogs().then(() => trace("logs loaded")),
          this.index.build().then(() => trace(`index built (${this.index.refs().length} cards)`)),
        ]);
        this.warnDuplicates();
        void this.ai.pullKey();
        const probe = window.setTimeout(() => void this.checkDownloads(), 8000);
        this.register(() => window.clearTimeout(probe));
        await this.terms.init();
        trace("terms ready");
        // A few new cards at a time, in the background, only if AI is on (never large runs).
        this.registerInterval(window.setInterval(() => void this.ai.autoRun(), 10 * 60_000));
        const first = window.setTimeout(() => void this.ai.autoRun(), 60_000);
        this.register(() => window.clearTimeout(first));
      } catch (e) {
        console.error("Flashcards: startup failed", e);
        new Notice("Osteon couldn't finish loading. See the developer console for details.");
      } finally {
        this.ready = true;
        this.events.trigger("changed");
        trace("ready");
      }
      // Linked notes and exam maps are only needed on a card's back or the exam screens, and loading
      // them (folder scan + a 54k-line manifest) took ~2 s on the phone: do it after the decks are up.
      try {
        await this.links.rebuild();
        trace("links ready");
        await this.exams.load();
        this.events.trigger("changed");
        trace("exams ready");
        await ensureImportBaseline(this);
      } catch (e) {
        console.error("Flashcards: loading linked notes or exam maps failed", e);
      }
    });
  }

  onunload(): void {
    this.saveSettingsSoon.run();
    this.terms?.hide();
    this.terms?.rebuildSoon.cancel();
    this.notify.cancel();
    this.checkAliases.cancel();
    this.reloadLogsSoon.cancel();
  }

  private notify = debounce(() => this.events.trigger("changed"), 150, true);

  private reloadLogsSoon = debounce(
    () => {
      this.reloadLogs()
        .then(() => this.events.trigger("changed"))
        .catch((e) => console.error("Flashcards: reloading review logs failed", e));
    },
    500,
    true,
  );

  private replayOptions() {
    return { schedulerFor: (key: string) => this.schedulerForKey(key), dayStartHour: this.settings.dayStartHour };
  }

  private makeSchedulers(): void {
    this.fsrsByPreset.clear();
    for (const p of Object.values(this.settings.presets)) this.fsrsByPreset.set(p.id, makeScheduler(p.scheduler));
  }

  private schedulerForKey(key: string): FSRS {
    const presetId = this.cardPreset.get(key.split(".")[0]) ?? "default";
    return this.fsrsByPreset.get(presetId) ?? this.fsrsByPreset.get("default")!;
  }

  presetFor(deck: string | null): Preset {
    const s = this.settings;
    return s.presets[presetIdFor(deck, s.deckPresets, s.presets)];
  }

  /**
   * Cards are scheduled with their deck's preset. When a card's preset changes (it moved deck,
   * or a deck was assigned another preset), its history is replayed with the new options.
   */
  private updateCardPresets(): void {
    const next = new Map<string, string>();
    const s = this.settings;
    for (const ref of this.index.refs()) {
      if (ref.card.id) next.set(ref.card.id, presetIdFor(ref.deck, s.deckPresets, s.presets));
    }
    let changed = false;
    for (const [id, p] of next) {
      if ((this.cardPreset.get(id) ?? "default") !== p) {
        changed = true;
        break;
      }
    }
    this.cardPreset = next;
    if (changed) this.state.rebuild();
  }

  /** Re-scan notes and reload logs after the folder settings change. */
  async applyFolderSettings(): Promise<void> {
    await this.saveData(this.settings);
    await this.reloadLogs();
    await this.index.build();
    this.events.trigger("changed");
  }

  /** For fields saved while typing: one save (and one history replay) after a pause. */
  saveSettingsSoon = debounce(() => void this.saveSettings(), 700, true);

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.makeSchedulers();
    const s = this.settings;
    for (const ref of this.index.refs()) {
      if (ref.card.id) this.cardPreset.set(ref.card.id, presetIdFor(ref.deck, s.deckPresets, s.presets));
    }
    // Changing FSRS options recomputes every card from its history (spec 0001 §4.3).
    this.state.setOptions(this.replayOptions());
    this.events.trigger("changed");
  }

  /** Every device seen in the review logs (deck list: "Latest from iPhone …"). */
  devices: Record<string, DeviceInfo> = {};

  async reloadLogs(): Promise<void> {
    const { events, bad, devices } = await this.logs.loadAll();
    this.devices = devices;
    // Keep this device's answers that may have been appended while the files were being read;
    // duplicates are dropped by ReviewState.
    const own = this.state.allEvents().filter((e) => e.device === this.logs.device);
    this.state.load([...events, ...own]);
    this.invalidateItems();
    for (const b of bad) {
      console.warn(`Flashcards: skipped unreadable lines ${b.lines.join(", ")} in ${b.path}`);
    }
  }

  /**
   * Record an event. State updates at once (synchronously, before the first await) so the reviewer
   * can move on; the returned promise settles when the line is on disk. Writes stay in order (the
   * log store queues them), and a failed write is reported rather than silently lost.
   */
  async logEvent(e: LogEvent): Promise<void> {
    const full = { ...e, device: this.logs.device };
    this.state.add(full);
    this.invalidateItems();
    this.events.trigger("changed");
    try {
      await this.logs.append(full);
    } catch (err) {
      console.error("Flashcards: couldn't save an event to the review log", full, err);
      new Notice("A review couldn't be saved to disk (see the developer console). Keep Obsidian open and try again.", 10000);
      throw err;
    }
  }

  /** Log many events (e.g. a migration) with one state rebuild at the end. */
  async logEvents(events: LogEvent[]): Promise<void> {
    if (!events.length) return;
    const full = events.map((e) => ({ ...e, device: this.logs.device }));
    for (const e of full) await this.logs.append(e);
    this.state.load([...this.state.allEvents(), ...full]);
    this.invalidateItems();
    this.events.trigger("changed");
  }

  /** Replace a card's source lines (inline editor). False if the note changed meanwhile. */
  async editCard(ref: CardRef, source: string): Promise<boolean> {
    const file = this.app.vault.getFileByPath(ref.path);
    if (!file) return false;
    let written: string | null = null;
    await this.app.vault.process(file, (text) => {
      const out = replaceCardSource(text, ref.card, source);
      if (out === null) return text;
      written = out;
      return out;
    });
    if (written === null) return false;
    this.index.updateFromText(file, written);
    return true;
  }

  /**
   * Cards or review state changed: cached queue items are stale. Every change that fires "changed"
   * calls this (logEvent, index updates, log reloads), so a cache is never read across a change.
   */
  private itemsGen = 0;
  private itemsCache: { gen: number; all: QueueItem[] | null; byDeck: Map<string, QueueItem[]>; study: Map<string, QueueItem[]> } = {
    gen: -1,
    all: null,
    byDeck: new Map(),
    study: new Map(),
  };
  invalidateItems(): void {
    this.itemsGen++;
  }

  /**
   * Queue items for a deck (and its sub-decks), or every deck when `deck` is null. Cached until the
   * next change: the deck list asks for every deck on each redraw, and the reviewer after every card.
   * Callers must not mutate the returned array.
   */
  items(deck: string | null): QueueItem[] {
    const c = this.itemsCache;
    if (c.gen !== this.itemsGen) {
      c.gen = this.itemsGen;
      c.all = null;
      c.byDeck.clear();
      c.study.clear();
    }
    c.all ??= this.index.refs().map((ref) => ({ ref, state: ref.key ? this.state.get(ref.key) : undefined }));
    if (deck === null) return c.all;
    const key = deck.toLowerCase();
    let list = c.byDeck.get(key);
    if (!list) {
      list = c.all.filter((i) => inDeck(i.ref.deck, deck));
      c.byDeck.set(key, list);
    }
    return list;
  }

  /** What studying `deck` covers: its items minus hidden decks it is not itself inside (cached like items()). */
  studyItems(deck: string | null): QueueItem[] {
    const hidden = this.settings.hiddenDecks;
    const list = this.items(deck);
    if (!hidden.length) return list;
    const c = this.itemsCache;
    const key = deck === null ? "\u0000all" : deck.toLowerCase();
    let out = c.study.get(key);
    if (!out) {
      out = list.filter((i) => !hiddenFrom(i.ref.deck, deck, hidden));
      c.study.set(key, out);
    }
    return out;
  }

  isDeckHidden(deck: string): boolean {
    return this.settings.hiddenDecks.includes(deck.toLowerCase());
  }

  /** Hide a deck from the deck list and "Study all", or show it again. Its cards are untouched. */
  async setDeckHidden(deck: string, hide: boolean): Promise<void> {
    const k = deck.toLowerCase();
    const rest = this.settings.hiddenDecks.filter((d) => d !== k);
    this.settings.hiddenDecks = hide ? [...rest, k] : rest;
    await this.saveData(this.settings);
    this.invalidateItems();
    // Hidden decks aren't read (unless shown): unhiding has to load the deck's cards.
    if (this.index.includesHidden) this.events.trigger("changed");
    else await this.index.build();
  }

  /**
   * Anki's Rename: `from` (and its sub-decks) shows as `to` from now on. Notes are not edited; the
   * rename is a rule in settings. The deck's preset, hidden state and today's extra limits move with it.
   */
  async renameDeck(from: string, to: string): Promise<void> {
    const s = this.settings;
    s.deckRenames = addRename(s.deckRenames, from, to);
    const move = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [moveDeckKey(k, from, to), v]));
    s.deckPresets = move(s.deckPresets);
    s.todayExtra = move(s.todayExtra);
    s.hiddenDecks = [...new Set(s.hiddenDecks.map((k) => moveDeckKey(k, from, to)))];
    await this.saveData(s);
    if (this.index.includesHidden) this.index.decksRenamed();
    else await this.index.build(); // the rename may move a deck into or out of a hidden one
  }

  /**
   * `timed`: a timed sitting puts the cards most at risk first (most overdue reviews, then new),
   * so stopping when the time is up leaves the least important ones.
   */
  queue(deck: string | null, now = new Date(), timed = false): Queue {
    const p = this.presetFor(deck);
    const s = this.settings;
    const extra = this.todayExtra(deck, now);
    return buildQueue(
      this.studyItems(deck),
      now,
      {
        newPerDay: p.newPerDay + extra.newExtra,
        reviewsPerDay: p.reviewsPerDay + extra.reviewExtra,
        dayStartHour: s.dayStartHour,
        learnAheadMins: s.learnAheadMins,
        display: timed ? { ...p.display, reviewOrder: "overdue", newReviewMix: "after" } : p.display,
        bury: p.bury,
        missCap: s.restAfterMisses,
        newPauseAbove: s.adaptiveNew ? s.adaptiveNewPile : 0,
      },
      (d) => this.presetFor(d),
    );
  }

  /** Custom Study's "increase today's limit" for a deck (0 once the study day is over). */
  todayExtra(deck: string | null, now = new Date()): { newExtra: number; reviewExtra: number } {
    const e = this.settings.todayExtra[(deck ?? "").toLowerCase()];
    const today = dayStart(now.getTime(), this.settings.dayStartHour);
    return e && e.day === today ? { newExtra: e.newExtra, reviewExtra: e.reviewExtra } : { newExtra: 0, reviewExtra: 0 };
  }

  async extendToday(deck: string | null, kind: "new" | "review", n: number): Promise<void> {
    const key = (deck ?? "").toLowerCase();
    const day = dayStart(Date.now(), this.settings.dayStartHour);
    const cur = this.settings.todayExtra[key];
    const e = cur && cur.day === day ? cur : { day, newExtra: 0, reviewExtra: 0 };
    if (kind === "new") e.newExtra += n;
    else e.reviewExtra += n;
    // Keep only today's entries.
    for (const [k, v] of Object.entries(this.settings.todayExtra)) if (v.day !== day) delete this.settings.todayExtra[k];
    this.settings.todayExtra[key] = e;
    await this.saveData(this.settings);
    this.events.trigger("changed");
  }

  // ---- filtered decks (spec 0008) -------------------------------------------------------

  filteredDeck(id: string): FilteredDeck | undefined {
    return this.settings.filteredDecks.find((d) => d.id === id);
  }

  /** Save (create or update) a filtered deck and build it. Returns the number of cards taken. */
  async buildFilteredDeck(def: FilteredDeck, cards?: string[]): Promise<number> {
    const now = Date.now();
    // `cards`: a list picked by the caller (an extra); Rebuild later uses the search.
    def.cards = cards ?? buildFiltered(this.items(null), def, now, this.settings.dayStartHour, this.searchCtx);
    def.builtAt = now;
    const list = this.settings.filteredDecks;
    const i = list.findIndex((d) => d.id === def.id);
    if (i >= 0) list[i] = def;
    else list.push(def);
    await this.saveData(this.settings);
    this.events.trigger("changed");
    return def.cards.length;
  }

  async emptyFilteredDeck(id: string): Promise<void> {
    const d = this.filteredDeck(id);
    if (!d) return;
    d.cards = [];
    d.builtAt = undefined;
    await this.saveData(this.settings);
    this.events.trigger("changed");
  }

  async deleteFilteredDeck(id: string): Promise<void> {
    this.settings.filteredDecks = this.settings.filteredDecks.filter((d) => d.id !== id);
    await this.saveData(this.settings);
    this.events.trigger("changed");
  }

  /**
   * "Study this note's cards": a filtered deck of the note's own cards plus every card linked to
   * it (spec 0011), due first, answers counting as normal reviews. Reuses one deck per note.
   */
  async studyNote(file: TFile): Promise<void> {
    await this.studySearch(`Note: ${file.basename}`, `note:"${file.path}"`, `No cards in or linked to "${file.basename}"`);
  }

  /** Build (or rebuild) the named filtered deck from a search, due first, and start it. */
  async studySearch(name: string, search: string, empty = `No cards match ${search}`): Promise<void> {
    const existing = this.settings.filteredDecks.find((d) => d.name === name);
    const def: FilteredDeck = existing ?? { id: `s-${Date.now().toString(36)}`, name, search, limit: 9999, order: "due", reschedule: true };
    def.search = search;
    const n = await this.buildFilteredDeck(def);
    if (!n) {
      new Notice(`${empty} (suspended and buried cards are left out).`);
      if (!existing) await this.deleteFilteredDeck(def.id);
      return;
    }
    await this.openFiltered(def.id);
  }

  filteredQueueFor(def: FilteredDeck, done?: Set<string>): Queue {
    return filteredQueue(this.items(null), def, Date.now(), done);
  }

  /** A new card that got its ID during a filtered session: keep it in the deck's snapshot. */
  async renameFilteredCard(oldId: string, newId: string): Promise<void> {
    let changed = false;
    for (const d of this.settings.filteredDecks) {
      const i = d.cards?.indexOf(oldId) ?? -1;
      if (i >= 0) {
        d.cards![i] = newId;
        changed = true;
      }
    }
    if (changed) await this.saveData(this.settings);
  }

  today(): TodayStats {
    return todayStats(this.items(null), Date.now(), this.settings.dayStartHour);
  }

  /** The FSRS scheduler for a card (its deck's preset). */
  schedulerFor(ref: CardRef): FSRS {
    return this.fsrsByPreset.get(presetIdFor(ref.deck, this.settings.deckPresets, this.settings.presets)) ?? this.fsrsByPreset.get("default")!;
  }

  /**
   * Give a card its permanent ID on first review (spec 0001 §4.1): written once, atomically,
   * and only if the note still matches what was parsed. Returns the card key, or null.
   */
  async ensureKey(ref: CardRef): Promise<string | null> {
    if (ref.card.id) return `${ref.card.id}.${ref.slot}`;
    const file = this.app.vault.getFileByPath(ref.path);
    if (!file) return null;
    const id = newCardId((x) => this.index.hasId(x));
    let written: string | null = null;
    await this.app.vault.process(file, (text) => {
      const out = insertCardId(text, ref.card, id);
      if (out === null) return text;
      written = out;
      return out;
    });
    if (written === null) return null;
    // Re-parse now (an occlusion ID adds a line), rather than waiting for the metadata cache.
    this.index.updateFromText(file, written);
    return `${id}.${ref.slot}`;
  }

  /** Keep an edited ==cloze=='s history (spec 0002 §3.4) by logging an alias once. */
  private checkAliases = debounce(
    () => {
      if (!this.ready) return;
      void (async () => {
        const history = slotsById(this.state.states);
        for (const card of this.index.cardsWithIds()) {
          if (card.type !== "cloze") continue;
          const alias = findClozeAlias(card, history.get(card.id!) ?? []);
          if (alias) {
            await this.logEvent({ ts: new Date().toISOString(), type: "alias", key: alias.to, from: alias.from });
          }
        }
      })().catch((e) => console.error("Flashcards: alias check failed", e));
    },
    2000,
    true,
  );

  private warnDuplicates(): void {
    const dups = this.index.duplicateIds();
    if (dups.size === 0) return;
    const [id, paths] = [...dups][0];
    new Notice(
      `Osteon: ${dups.size} card ID(s) appear more than once (e.g. ^fc-${id} in ${paths.join(" and ")}). ` +
        "They share one history until one copy's ID is removed.",
      10000,
    );
  }

  async openDecks(): Promise<void> {
    await this.openView(VIEW_DECKS, {});
  }

  /** The note a tab shows (also for a tab Obsidian hasn't loaded yet). */
  private fileIn(leaf: WorkspaceLeaf | null): TFile | null {
    if (!leaf) return null;
    const open = (leaf.view as { file?: TFile | null }).file;
    if (open) return open;
    const path = (leaf.getViewState().state as { file?: unknown } | undefined)?.file;
    return typeof path === "string" ? this.app.vault.getFileByPath(path) : null;
  }

  /** The shortcut note (settings.homeNote) stands for the deck list: opening it shows the decks in its place. */
  private async openHomeIfShortcut(file: TFile | null, inLeaf?: WorkspaceLeaf | null): Promise<void> {
    const home = this.settings.homeNote;
    if (!file || !home || file.path !== normalizePath(home)) return;
    const { workspace } = this.app;
    const leaf = inLeaf ?? workspace.getLeavesOfType("markdown").find((l) => this.fileIn(l)?.path === file.path);
    if (!leaf || leaf.view.getViewType() !== "markdown") return;
    // "file-open" and "active-leaf-change" both arrive for one opening: handle it once.
    if (this.openingHome) return;
    this.openingHome = true;
    try {
      const decks = workspace.getLeavesOfType(VIEW_DECKS).find((l) => l !== leaf);
      if (decks) {
        leaf.detach();
        await workspace.revealLeaf(decks);
      } else {
        await leaf.setViewState({ type: VIEW_DECKS, active: true, state: {} });
      }
    } finally {
      this.openingHome = false;
    }
  }

  private openingHome = false;

  /** Turn an image embed line into an occlusion block via the editor (spec 0004 §3). */
  private createOcclusion(editor: Editor, path: string, lineNo: number, embed: string): void {
    const line = editor.getLine(lineNo);
    if (line.trim() !== embed.trim()) {
      new Notice("Put the image on a line of its own first, then create the occlusion.");
      return;
    }
    const wiki = /^!\[\[([^\]|#]+)/.exec(embed);
    const md = /^!\[[^\]]*\]\(([^)\s]+)/.exec(embed);
    let image = wiki ? wiki[1].trim() : md ? md[1] : "";
    if (md) {
      try {
        image = decodeURI(image);
      } catch {
        // Keep the raw path if it isn't valid percent-encoding.
      }
    }
    if (!image) return;
    const initial: Occlusion = { image, mode: "hide-all", masks: [], groups: [] };
    new OcclusionEditorModal(this.app, initial, path, [], async (occ) => {
      if (editor.getLine(lineNo) !== line) {
        new Notice("The note changed while the editor was open; the figure wasn't inserted.");
        return false;
      }
      const block = "```" + OCCLUSION_LANG + "\n" + serializeOcclusion(occ) + "\n```";
      editor.replaceRange(block, { line: lineNo, ch: 0 }, { line: lineNo, ch: line.length });
      // A figure in a note the plugin does not read makes no cards: say so instead of staying quiet.
      const file = this.app.vault.getFileByPath(path);
      if (file && !this.index.shouldScan(file, this.app.metadataCache.getFileCache(file))) {
        new Notice("Figure saved. Add the #flashcards tag to this note so its cards show up in your decks.", 10000);
      }
      return true;
    }).open();
  }

  /**
   * Open the editor for an existing block whose fence starts at `startLine` and whose lines
   * (fence to fence, possibly followed by back lines) are `expected`.
   */
  editOcclusion(path: string, startLine: number, expected: string[], occ: Occlusion, onSaved?: () => void): void {
    const closeIdx = expected.findIndex((l, i) => i > 0 && /^\s*(`{3,}|~{3,})\s*$/.test(l));
    if (closeIdx < 0 || !/^\s*(`{3,}|~{3,})/.test(expected[0])) {
      new Notice("This figure is inside a quote or callout; move it out to edit it.");
      return;
    }
    const fence = expected.slice(0, closeIdx + 1);
    const historical = occ.id ? slotsWithHistory(occ.id, this.state.states) : [];
    new OcclusionEditorModal(this.app, occ, path, historical, async (next) => {
      const file = this.app.vault.getFileByPath(path);
      if (!file) return false;
      let ok = false;
      let written = "";
      await this.app.vault.process(file, (text) => {
        const lines = text.split("\n");
        for (let i = 0; i < fence.length; i++) if (lines[startLine + i] !== fence[i]) return text;
        lines.splice(startLine + 1, fence.length - 2, ...serializeOcclusion(next).split("\n"));
        ok = true;
        written = lines.join("\n");
        return written;
      });
      if (!ok) {
        new Notice("The note changed while the editor was open; reopen the figure and try again.");
        return false;
      }
      this.index.updateFromText(file, written);
      onSaved?.();
      return true;
    }).open();
  }

  /**
   * Obsidian doesn't update links inside code blocks, so when an image used by an occlusion
   * block is renamed or moved, rewrite the block's `image:` line (spec 0004 §5).
   */
  private async relinkOcclusionImages(file: TFile, oldPath: string): Promise<void> {
    const oldName = oldPath.split("/").pop() ?? oldPath;
    const paths = new Set<string>();
    for (const ref of this.index.refs()) {
      const img = ref.card.occlusion?.image;
      if (img && (img === oldPath || img === oldName)) paths.add(ref.path);
    }
    for (const path of paths) {
      const note = this.app.vault.getFileByPath(path);
      if (!note) continue;
      const link = this.app.metadataCache.fileToLinktext(file, path, false);
      let written = "";
      await this.app.vault.process(note, (text) => {
        let inBlock = false;
        const out = text.split("\n").map((line) => {
          if (new RegExp(`^\\s*(\`{3,}|~{3,})\\s*${OCCLUSION_LANG}\\s*$`).test(line)) inBlock = true;
          else if (inBlock && /^\s*(`{3,}|~{3,})\s*$/.test(line)) inBlock = false;
          else if (inBlock) {
            const m = /^(\s*image:\s*)\[\[([^\]|]+)(\|[^\]]*)?\]\]\s*$/.exec(line);
            if (m && (m[2] === oldPath || m[2] === oldName)) return `${m[1]}[[${link}]]`;
          }
          return line;
        });
        written = out.join("\n");
        return written;
      });
      if (written) this.index.updateFromText(note, written);
    }
  }

  openAddCard(deck: string | null): void {
    new AddCardModal(this.app, this, deck).open();
  }

  async openBrowse(query?: string): Promise<void> {
    await this.openView(VIEW_BROWSE, query === undefined ? {} : { query });
  }

  /** The card under review, if a review tab is showing one. */
  reviewContext(): { ref: CardRef; side: "front" | "back" } | null {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_REVIEW)) {
      const ctx = leaf.view instanceof ReviewView ? leaf.view.context() : null;
      if (ctx) return ctx;
    }
    return null;
  }

  /** The AI helper in the right sidebar; it follows the card under review. Focus stays on the card. */
  async openAssistant(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_AI)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return;
      leaf = right;
      await leaf.setViewState({ type: VIEW_AI, active: false });
    }
    await workspace.revealLeaf(leaf);
  }

  async openLeeches(): Promise<void> {
    await this.openView(VIEW_LEECHES, {});
  }

  /** Cards answered Again at least twice today, in visible decks (deck list button, Weak spots). */
  weakToday(): WeakCard[] {
    return weakCards(this.studyItems(null), dayStart(Date.now(), this.settings.dayStartHour), 2);
  }

  async openWeak(): Promise<void> {
    await this.openView(VIEW_WEAK, {});
  }

  /** The card's linked note (spec 0011) first, then notes it mentions by title or alias. */
  relatedFor(ref: CardRef): TFile[] {
    const manual = this.manualNotes(ref);
    const linked = [...manual, ...this.links.files(ref).filter((f) => f.path !== ref.path && !manual.includes(f))];
    const text = [ref.card.front, ref.card.answer, ref.card.back, ref.card.occlusion?.header ?? "", ...(ref.card.occlusion?.masks.map((m) => m.label ?? "") ?? [])].join("\n");
    const mentioned = this.terms.relatedNotes(text, [ref.path, ...linked.map((f) => f.path)], Math.max(0, 3 - linked.length));
    // (Title-word matching is deliberately NOT used here: measured on 32k real cards it was wrong
    // too often to decide where N goes. It only proposes candidates for the AI helper to choose from.)
    return [...linked, ...mentioned].slice(0, Math.max(3, manual.length));
  }

  // ---- notes linked to a card by hand -----------------------------------------------------------

  /** The notes the student linked to this card (More → Link a note to this card), first one first. */
  manualNotes(ref: CardRef): TFile[] {
    const id = ref.card.id;
    if (!id) return [];
    return (this.settings.cardNotes[id] ?? []).map((p) => this.app.vault.getFileByPath(p)).filter((f): f is TFile => !!f);
  }

  /** Link a note to a card; the newest link goes first, so N opens it. */
  async linkNote(ref: CardRef, file: TFile): Promise<boolean> {
    const key = await this.ensureKey(ref);
    if (!key) return false;
    const id = key.split(".")[0];
    // A card never answered before gets its ID just now; the caller's copy must know it too, or the
    // link wouldn't show (or open on N) until the card came round again.
    if (!ref.card.id) ref.card.id = id;
    const now = this.settings.cardNotes[id] ?? [];
    this.settings.cardNotes[id] = [file.path, ...now.filter((p) => p !== file.path)];
    await this.saveData(this.settings);
    return true;
  }

  async unlinkNote(ref: CardRef, path: string): Promise<void> {
    const id = ref.card.id;
    if (!id) return;
    const left = (this.settings.cardNotes[id] ?? []).filter((p) => p !== path);
    if (left.length) this.settings.cardNotes[id] = left;
    else delete this.settings.cardNotes[id];
    await this.saveData(this.settings);
  }

  /** A renamed or moved note keeps its card links. */
  private async renameLinkedNote(oldPath: string, newPath: string): Promise<void> {
    let changed = false;
    for (const [id, paths] of Object.entries(this.settings.cardNotes)) {
      if (!paths.includes(oldPath)) continue;
      this.settings.cardNotes[id] = paths.map((p) => (p === oldPath ? newPath : p));
      changed = true;
    }
    if (changed) await this.saveData(this.settings);
  }

  private matcher?: { built: number; count: number; m: NoteMatcher };

  /**
   * The student's own notes (not imported decks, not the plugin's data) whose titles or aliases
   * share a distinctive word with `text`. The title index is rebuilt when notes come or go, or
   * after five minutes.
   */
  noteMatches(text: string, max = 3): TFile[] {
    const files = this.app.vault.getMarkdownFiles();
    if (!this.matcher || this.matcher.count !== files.length || Date.now() - this.matcher.built > 300_000) {
      const data = this.settings.stateFolder + "/";
      const notes: TitledNote[] = [];
      for (const f of files) {
        if (f.path.startsWith(data)) continue;
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        if (fm?.["anki-deck"]) continue;
        const aliases: unknown = fm?.aliases ?? fm?.alias ?? [];
        notes.push({ path: f.path, names: [f.basename, ...(Array.isArray(aliases) ? aliases : [aliases]).filter((a): a is string => typeof a === "string")] });
      }
      this.matcher = { built: Date.now(), count: files.length, m: new NoteMatcher(notes) };
    }
    return this.matcher.m
      .match(text.replace(/<[^>]+>/g, " "), max)
      .map((p) => this.app.vault.getFileByPath(p))
      .filter((f): f is TFile => !!f);
  }

  /** Read a few pictures; if they don't arrive, the vault is probably offloaded from this device. */
  private async checkDownloads(): Promise<void> {
    if (!this.settings.checkDownloads) return;
    const pics = this.app.vault.getFiles().filter((f) => /^(png|jpe?g|webp|gif)$/i.test(f.extension));
    if (!pics.length) return;
    const paths = samplePaths(pics.map((f) => f.path), 5);
    const res = await probeDownloads((p) => this.app.vault.adapter.readBinary(p), paths, 4000);
    if (!res.missing) return;
    console.warn("Osteon: pictures not readable in time", paths, res);
    new Notice(
      `Osteon: ${res.missing} of ${res.checked} pictures checked aren't downloaded to this device. Cards and notes with pictures may hang. In the Files app, long-press the vault folder and choose Keep Downloaded.`,
      20000,
    );
  }

  /** Leech cards in visible decks (see core/leeches.ts). */
  leeches(): QueueItem[] {
    return findLeeches(this.studyItems(null), (deck) => this.presetFor(deck).leechThreshold, this.settings.leechDone);
  }

  /** Deal with a leech from the Leeches screen: "retry" unsuspends it, "drop" keeps it suspended. */
  async resolveLeech(item: QueueItem, how: "retry" | "drop", message: string): Promise<void> {
    const key = item.ref.key ?? (await this.ensureKey(item.ref));
    if (!key) return;
    const st = this.state.get(key);
    const ts = new Date().toISOString();
    const events: LogEvent[] = [];
    if (how === "retry" && st?.suspended) events.push({ ts, type: "unsuspend", key });
    if (how === "drop" && !st?.suspended) events.push({ ts, type: "suspend", key });
    if (st?.marked) events.push({ ts: new Date(Date.now() + 1).toISOString(), type: "mark", key, marked: false });
    this.settings.leechDone[key] = st?.card.lapses ?? 0;
    await this.saveSettings();
    if (events.length) await this.logEvents(events);
    else this.events.trigger("changed");
    new Notice(message);
  }

  async openMisses(): Promise<void> {
    await this.openView(VIEW_MISSES, {});
  }

  async openStats(deck: string | null = null): Promise<void> {
    await this.openView(VIEW_STATS, { deck });
  }

  async openReview(deck: string | null): Promise<void> {
    await this.openView(VIEW_REVIEW, { deck, filtered: null });
  }

  async openFiltered(id: string): Promise<void> {
    await this.openView(VIEW_REVIEW, { deck: null, filtered: id });
  }

  private async openView(type: string, state: Record<string, unknown>): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(type)[0] ?? null;
    if (!leaf) leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type, active: true, state });
    await workspace.revealLeaf(leaf);
  }
}
