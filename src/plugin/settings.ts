import type { DeckRename } from "../core/collection";
import { App, normalizePath, Notice, PluginSettingTab, Setting } from "obsidian";
import type { FilteredDeck } from "../core/filtered";
import { DEFAULT_PAD_BINDINGS, PAD_ACTIONS, resolveAction, type PadAction, type PadBindings } from "../core/gamepad";
import { completePreset, DEFAULT_PRESET_ID, defaultPreset, type Preset } from "../core/presets";
import type FlashcardsPlugin from "../main";
import { DeckOptionsModal } from "./modals/deck-options";
import { AI_PROVIDERS, aiKeyId, isProvider, type AiProvider } from "../core/ai-providers";
import { getSecret, setSecret, writeKeyFile } from "./secrets";

export const ACTIONS = {
  showAnswer: "Show answer",
  again: "Again",
  hard: "Hard",
  good: "Good",
  easy: "Easy",
  undo: "Undo",
  editCard: "Edit card",
  openNote: "Open note",
  aiHelper: "AI helper (side panel)",
  mark: "Mark",
  flag1: "Flag red",
  flag2: "Flag orange",
  flag3: "Flag green",
  flag4: "Flag blue",
  flag5: "Flag pink",
  flag6: "Flag turquoise",
  flag7: "Flag purple",
  toggleMasks: "Toggle masks (image occlusion)",
  revealNext: "Reveal next answer (one by one)",
  revealAll: "Reveal or hide all answers (one by one)",
  bury: "Bury card",
  suspend: "Suspend card",
  setDue: "Set due date",
  cardInfo: "Card info",
  deckOptions: "Deck options",
  decks: "Go to decks (Anki: D)",
  browse: "Browse (Anki: B)",
  addCard: "Add card (Anki: A)",
  stats: "Statistics, from the deck list (Anki: T)",
  filteredDeck: "Create filtered deck, from the deck list (Anki: F)",
  customStudy: "Custom study, from a deck's overview (Anki: C)",
  close: "Close review",
} as const;
export type ActionName = keyof typeof ACTIONS;

/** Anki's review keys (spec 0003 §2). Space/Enter also mean Good once the answer is shown. */
export const DEFAULT_KEYS: Record<ActionName, string[]> = {
  showAnswer: ["Space", "Enter"],
  again: ["1"],
  hard: ["2"],
  good: ["3"],
  easy: ["4"],
  undo: ["Mod+z", "u"],
  editCard: ["e"],
  openNote: ["n"],
  aiHelper: ["h"],
  mark: ["*"],
  flag1: ["Mod+1"],
  flag2: ["Mod+2"],
  flag3: ["Mod+3"],
  flag4: ["Mod+4"],
  flag5: ["Mod+5"],
  flag6: ["Mod+6"],
  flag7: ["Mod+7"],
  toggleMasks: ["t"],
  revealNext: ["n"],
  revealAll: [","],
  bury: ["-"],
  suspend: ["@"],
  setDue: ["Mod+Shift+D"],
  cardInfo: ["i"],
  deckOptions: ["o"],
  decks: ["d"],
  browse: ["b"],
  addCard: ["a"],
  stats: ["t"],
  filteredDeck: ["f"],
  customStudy: ["c"],
  close: ["Escape"],
};

export type CardTheme = "obsidian" | "anki" | "anking" | "paper" | "contrast" | "image";

export const CARD_THEMES: Record<CardTheme, string> = {
  obsidian: "Match my Obsidian theme",
  anki: "Anki Classic",
  anking: "AnKing",
  paper: "Paper (sepia)",
  contrast: "High contrast",
  image: "Background image",
};

export interface HoverSettings {
  sensitivity: "strict" | "all" | "uncommon" | "off";
  onFront: boolean;
  inNotes: boolean;
  useNotes: boolean;
  useMesh: boolean;
}

export type AiModel = "claude-opus-5" | "claude-sonnet-5" | "claude-haiku-4-5";

export interface AiSettings {
  enabled: boolean;
  /** Which service the helpers call. */
  provider: AiProvider;
  /** The Claude model, when the provider is Anthropic. */
  model: AiModel;
  /** The model name for any other provider, as that provider spells it. */
  otherModel: string;
  /** Server address for the "custom" provider, e.g. http://localhost:11434/v1. */
  baseUrl: string;
  /** Folders whose cards are never sent to the API. */
  excludeFolders: string[];
  /** Look at new or edited cards in the background (small batches only). */
  autoRun: boolean;
  /** Keep a copy of the API key in the plugin folder so the owner's other devices pick it up. */
  syncKey: boolean;
}

export interface FlashcardsSettings {
  stateFolder: string;
  cardFolders: string[];
  presets: Record<string, Preset>;
  /** Lower-cased deck path → preset ID. */
  deckPresets: Record<string, string>;
  dayStartHour: number;
  learnAheadMins: number;
  showIntervals: boolean;
  showRemaining: boolean;
  /** The Review Heatmap add-on's year view under the deck list. */
  showHeatmap: boolean;
  /** Reveal a card's answers one at a time (👑) when it asks for at least this many; 0 = off. */
  oneByOneMin: number;
  /** A card answered Again this many times in one day rests until tomorrow; 0 = off (Anki's behaviour). */
  restAfterMisses: number;
  /** Adaptive new cards: hold new cards back while more than `adaptiveNewPile` cards are still in learning today. */
  adaptiveNew: boolean;
  adaptiveNewPile: number;
  /** At startup, check that the vault's pictures are downloaded to this device (iCloud can offload them). */
  checkDownloads: boolean;
  /** Opening this note opens the deck list instead (for a home-screen widget or bookmark); "" = off. */
  homeNote: string;
  /** Cards switched by hand to crowns (true) or away from them (false), by card key. */
  crownOverrides: Record<string, boolean>;
  /** Leeches dealt with on the Leeches screen: card key → its lapses then. */
  leechDone: Record<string, number>;
  /** Filtered decks (spec 0008), including Custom Study's "Custom Study Session". */
  filteredDecks: FilteredDeck[];
  /** Decks kept off the deck list and out of "Study all" (lower-cased paths); their cards stay. */
  hiddenDecks: string[];
  /** Deck renames (Anki's Rename), applied in order to the names notes give their cards. */
  deckRenames: DeckRename[];
  /** Notes the student linked to a card by hand: card id → note paths (N opens the first). */
  cardNotes: Record<string, string[]>;
  /** Custom Study "increase today's limit": lower-cased deck → extra cards for one study day. */
  todayExtra: Record<string, { day: number; newExtra: number; reviewExtra: number }>;
  fontSize: number;
  /** Game controller (spec 0010, like Anki's Contanki add-on). */
  gamepad: { enabled: boolean; bindings: PadBindings };
  /** Phone: tap the right side of the back for Good, the left for Again (like AnkiMobile). */
  tapToAnswer: boolean;
  /** Phone: shake to undo the last answer (like AnkiMobile). */
  shakeToUndo: boolean;
  /** Card theme (the review screen's card area), like Anki's card styling add-ons. */
  cardTheme: CardTheme;
  /** "image" theme: a picture from the vault behind the card, and how much to dim it (0–0.9). */
  cardBackground: string;
  cardBackgroundDim: number;
  /** Exam import (spec 0012): add `weak-area-<source>` to the frontmatter of missed notes. */
  tagExamMisses: boolean;
  keys: Record<ActionName, string[]>;
  hover: HoverSettings;
  ai: AiSettings;
}

export const DEFAULT_SETTINGS: FlashcardsSettings = {
  stateFolder: "Flashcards",
  cardFolders: [],
  presets: { [DEFAULT_PRESET_ID]: defaultPreset() },
  deckPresets: {},
  dayStartHour: 4,
  learnAheadMins: 20,
  showIntervals: true,
  showRemaining: true,
  showHeatmap: true,
  oneByOneMin: 2,
  restAfterMisses: 0,
  adaptiveNew: false,
  adaptiveNewPile: 20,
  checkDownloads: true,
  homeNote: "",
  crownOverrides: {},
  leechDone: {},
  filteredDecks: [],
  hiddenDecks: [],
  deckRenames: [],
  cardNotes: {},
  todayExtra: {},
  fontSize: 20,
  gamepad: { enabled: true, bindings: structuredClone(DEFAULT_PAD_BINDINGS) },
  tapToAnswer: true,
  shakeToUndo: true,
  cardTheme: "obsidian",
  cardBackground: "",
  cardBackgroundDim: 0.6,
  tagExamMisses: true,
  keys: { ...DEFAULT_KEYS },
  hover: { sensitivity: "strict", onFront: false, inNotes: false, useNotes: true, useMesh: true },
  ai: { enabled: false, provider: "anthropic", model: "claude-haiku-4-5", otherModel: "", baseUrl: "", excludeFolders: [], autoRun: true, syncKey: false },
};

/** Load saved settings, filling defaults and upgrading the v0.1 layout. */
export function mergeSettings(saved: Record<string, unknown> | null): FlashcardsSettings {
  const s = (saved ?? {}) as Partial<FlashcardsSettings> & {
    scheduler?: Preset["scheduler"];
    queue?: { newPerDay?: number; reviewsPerDay?: number; dayStartHour?: number; learnAheadMins?: number };
  };
  const presets: Record<string, Preset> = {};
  for (const [id, p] of Object.entries(s.presets ?? {})) presets[id] = completePreset({ ...p, id });
  if (!presets[DEFAULT_PRESET_ID]) {
    // v0.1 kept one set of options at the top level; it becomes the Default preset.
    presets[DEFAULT_PRESET_ID] = completePreset({
      id: DEFAULT_PRESET_ID,
      name: "Default",
      ...(s.queue?.newPerDay !== undefined ? { newPerDay: s.queue.newPerDay } : {}),
      ...(s.queue?.reviewsPerDay !== undefined ? { reviewsPerDay: s.queue.reviewsPerDay } : {}),
      ...(s.scheduler ? { scheduler: s.scheduler } : {}),
    } as Preset);
  }
  const out: FlashcardsSettings = {
    ...DEFAULT_SETTINGS,
    stateFolder: s.stateFolder ?? DEFAULT_SETTINGS.stateFolder,
    cardFolders: s.cardFolders ?? [],
    presets,
    deckPresets: s.deckPresets ?? {},
    dayStartHour: s.dayStartHour ?? s.queue?.dayStartHour ?? DEFAULT_SETTINGS.dayStartHour,
    learnAheadMins: s.learnAheadMins ?? s.queue?.learnAheadMins ?? DEFAULT_SETTINGS.learnAheadMins,
    showIntervals: s.showIntervals ?? true,
    showRemaining: s.showRemaining ?? true,
    showHeatmap: s.showHeatmap ?? true,
    oneByOneMin: s.oneByOneMin ?? 2,
    restAfterMisses: Number.isInteger(s.restAfterMisses) && s.restAfterMisses! >= 0 ? s.restAfterMisses! : 0,
    adaptiveNew: s.adaptiveNew ?? false,
    adaptiveNewPile: Number.isInteger(s.adaptiveNewPile) && s.adaptiveNewPile! > 0 ? s.adaptiveNewPile! : 20,
    checkDownloads: s.checkDownloads ?? true,
    homeNote: typeof s.homeNote === "string" ? s.homeNote : "",
    crownOverrides: s.crownOverrides ?? {},
    leechDone: s.leechDone ?? {},
    filteredDecks: Array.isArray(s.filteredDecks) ? s.filteredDecks : [],
    cardNotes: s.cardNotes && typeof s.cardNotes === "object" ? (s.cardNotes as Record<string, string[]>) : {},
    deckRenames: Array.isArray(s.deckRenames)
      ? s.deckRenames.filter((r): r is DeckRename => !!r && typeof r.from === "string" && typeof r.to === "string" && !!r.from && !!r.to)
      : [],
    hiddenDecks: Array.isArray(s.hiddenDecks) ? s.hiddenDecks.filter((d): d is string => typeof d === "string") : [],
    todayExtra: s.todayExtra ?? {},
    fontSize: s.fontSize ?? 20,
    gamepad: {
      enabled: s.gamepad?.enabled ?? true,
      bindings: s.gamepad?.bindings
        ? (Object.fromEntries((["question", "answer", "review", "decks", "all"] as const).map((c) => [c, s.gamepad!.bindings[c] ?? {}])) as PadBindings)
        : structuredClone(DEFAULT_PAD_BINDINGS),
    },
    tapToAnswer: s.tapToAnswer ?? true,
    shakeToUndo: s.shakeToUndo ?? true,
    cardTheme: s.cardTheme && s.cardTheme in CARD_THEMES ? s.cardTheme : "obsidian",
    cardBackground: s.cardBackground ?? "",
    cardBackgroundDim: s.cardBackgroundDim ?? 0.6,
    tagExamMisses: s.tagExamMisses ?? true,
    keys: withUndoU({ ...DEFAULT_KEYS, ...(s.keys ?? {}) }),
    hover: { ...DEFAULT_SETTINGS.hover, ...(s.hover ?? {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai ?? {}) },
  };
  if (!isProvider(out.ai.provider)) out.ai.provider = "anthropic";
  return out;
}

/** U joined Cmd/Ctrl+Z as Undo in 0.19.0; settings saved before then still say just Mod+z. */
function withUndoU(keys: Record<ActionName, string[]>): Record<ActionName, string[]> {
  if (keys.undo.length === 1 && keys.undo[0] === "Mod+z") keys.undo = ["Mod+z", "u"];
  return keys;
}

/** "Mod+z", "Space", "1", "@" from a keyboard event. Shift is implied by printable characters. */
export function keyString(e: KeyboardEvent): string {
  let key = e.key === " " ? "Space" : e.key;
  const printable = key.length === 1;
  if (printable) key = key.toLowerCase();
  let out = "";
  if (e.metaKey || e.ctrlKey) out += "Mod+";
  if (e.altKey) out += "Alt+";
  // With Mod held, keep Shift explicit (Mod+Shift+D); on its own it's implied by the character.
  if (e.shiftKey && (!printable || e.metaKey || e.ctrlKey)) out += "Shift+";
  return out + key;
}

export function normaliseKey(k: string): string {
  const parts = k.trim().split("+");
  const key = parts.pop() ?? "";
  if (!key) return "";
  const mods = parts.map((p) => (/^(cmd|ctrl|meta|mod)$/i.test(p) ? "Mod" : p[0].toUpperCase() + p.slice(1).toLowerCase()));
  const base = key.length === 1 ? key.toLowerCase() : key[0].toUpperCase() + key.slice(1);
  return [...mods, base].join("+");
}

export class FlashcardsSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
  ) {
    super(app, plugin);
  }

  hide(): void {
    this.plugin.saveSettingsSoon.run();
  }

  /** Game controller: on/off, a button tester, and the bindings per side (like Contanki). */
  private gamepadSettings(containerEl: HTMLElement, save: () => Promise<void>): void {
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Game controller").setHeading();
    new Setting(containerEl)
      .setName("Use a game controller")
      .setDesc("Like Anki's Contanki add-on (e.g. an 8BitDo Micro in controller mode). The buttons start with your Anki 8BitDo Micro setup.")
      .addToggle((t) =>
        t.setValue(s.gamepad.enabled).onChange(async (v) => {
          s.gamepad.enabled = v;
          await save();
        }),
      );
    const tester = new Setting(containerEl).setName("Which button is which?").setDesc("Press Test, then a controller button, to see its number.");
    tester.addButton((b) =>
      b.setButtonText("Test").onClick(() => {
        b.setButtonText("Press a button…");
        this.plugin.gamepad.listener = (n) => {
          this.plugin.gamepad.listener = null;
          const dir = { 100: " (left)", 101: " (right)", 102: " (up)", 103: " (down)" }[n as 100] ?? "";
          b.setButtonText(`Button ${n}${dir}`);
        };
      }),
    );
    const table = containerEl.createEl("table", { cls: "fc-pad-table" });
    const draw = () => {
      table.empty();
      const head = table.createEl("tr");
      for (const h of ["Button", "Question side", "Answer side", "Deck list"]) head.createEl("th", { text: h });
      const b = s.gamepad.bindings;
      const buttons = new Set<number>();
      for (const ctx of ["question", "answer", "review", "decks", "all"] as const) for (const k of Object.keys(b[ctx])) buttons.add(Number(k));
      for (const n of [...buttons].sort((x, y) => x - y)) {
        const tr = table.createEl("tr");
        const dir = { 100: " ←", 101: " →", 102: " ↑", 103: " ↓" }[n as 100] ?? "";
        tr.createEl("td", { text: `${n}${dir}` });
        for (const ctx of ["question", "answer", "decks"] as const) {
          const sel = tr.createEl("td").createEl("select", { cls: "dropdown" });
          sel.createEl("option", { text: "—", value: "" });
          for (const [k, label] of Object.entries(PAD_ACTIONS)) sel.createEl("option", { text: label, value: k });
          sel.value = resolveAction(b, n, ctx === "decks" ? "decks" : ctx);
          sel.onchange = async () => {
            b[ctx][String(n)] = sel.value as PadAction;
            await save();
          };
        }
      }
    };
    draw();
    new Setting(containerEl)
      .addButton((btn) =>
        btn.setButtonText("Add a button").onClick(() => {
          btn.setButtonText("Press it on the controller…");
          this.plugin.gamepad.listener = async (n) => {
            this.plugin.gamepad.listener = null;
            s.gamepad.bindings.all[String(n)] ??= "";
            await save();
            btn.setButtonText("Add a button");
            draw();
          };
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Reset to my 8BitDo Micro setup").onClick(async () => {
          s.gamepad.bindings = structuredClone(DEFAULT_PAD_BINDINGS);
          await save();
          draw();
        }),
      );
  }

  /** Card theme dropdown with a live sample card (and the background picture options). */
  private themeSettings(containerEl: HTMLElement, save: () => Promise<void>): void {
    const s = this.plugin.settings;
    const preview = createDiv();
    const extra = createDiv();
    const draw = () => {
      preview.empty();
      renderThemeSample(this.app, preview, s);
      extra.empty();
      if (s.cardTheme !== "image") return;
      new Setting(extra)
        .setName("Background picture")
        .setDesc("A picture in your vault, e.g. Attachments/Background.jpg")
        .addText((t) =>
          t.setValue(s.cardBackground).onChange(async (v) => {
            s.cardBackground = v.trim().replace(/^!?\[\[|\]\]$/g, "");
            await save();
            preview.empty();
            renderThemeSample(this.app, preview, s);
          }),
        );
      new Setting(extra)
        .setName("Dim the picture")
        .setDesc("Darker keeps the text readable.")
        .addSlider((sl) =>
          sl
            .setLimits(0, 0.9, 0.05)
            .setValue(s.cardBackgroundDim)
            .setDynamicTooltip()
            .onChange(async (v) => {
              s.cardBackgroundDim = v;
              await save();
              preview.empty();
              renderThemeSample(this.app, preview, s);
            }),
        );
    };
    new Setting(containerEl)
      .setName("Card theme")
      .setDesc("How cards look while you review. The sample below updates as you choose.")
      .addDropdown((d) => {
        for (const [k, label] of Object.entries(CARD_THEMES)) d.addOption(k, label);
        d.setValue(s.cardTheme).onChange(async (v) => {
          s.cardTheme = v as CardTheme;
          await save();
          draw();
        });
      });
    containerEl.appendChild(extra);
    containerEl.appendChild(preview);
    draw();
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = async () => this.plugin.saveSettings();
    containerEl.empty();

    const num = (name: string, desc: string, get: () => number, set: (v: number) => void, valid: (v: number) => boolean) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(String(get())).onChange(async (v) => {
            if (v.trim() === "") return;
            const n = Number(v);
            if (!Number.isFinite(n) || !valid(n)) return;
            set(n);
            this.plugin.saveSettingsSoon();
          }),
        );

    new Setting(containerEl).setName("Decks").setHeading();
    new Setting(containerEl)
      .setName("Presets")
      .setDesc(
        "Daily limits, learning steps, desired retention and more live in presets, as in Anki. " +
          "Open a deck's options from the gear icon in the deck list; this edits the Default preset.",
      )
      .addButton((b) =>
        b.setButtonText("Edit Default preset").onClick(() => new DeckOptionsModal(this.app, this.plugin, null).open()),
      );

    new Setting(containerEl).setName("Cards").setHeading();
    // Folder settings re-scan the vault, so they apply when the field loses focus, not per keystroke.
    new Setting(containerEl)
      .setName("Card folders")
      .setDesc("Notes tagged #flashcards are always scanned. Also scan every note in these folders (comma-separated).")
      .addText((t) => {
        t.setValue(s.cardFolders.join(", "));
        t.inputEl.addEventListener("change", async () => {
          s.cardFolders = t.getValue().split(",").map((x) => x.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
          await this.plugin.applyFolderSettings();
        });
      });
    new Setting(containerEl)
      .setName("Review data folder")
      .setDesc(
        "Where review history is kept (one sub-folder per device). Must not start with a dot, so it syncs. " +
          "Changing it does not move existing history: move the old folder in the file explorer first.",
      )
      .addText((t) => {
        t.setValue(s.stateFolder);
        t.inputEl.addEventListener("change", async () => {
          const folder = t.getValue().trim().replace(/^\/+|\/+$/g, "");
          if (!folder || folder.startsWith(".")) {
            new Notice("The review data folder can't be empty or start with a dot.");
            t.setValue(s.stateFolder);
            return;
          }
          if (folder === s.stateFolder) return;
          const old = s.stateFolder;
          s.stateFolder = folder;
          await this.plugin.applyFolderSettings();
          if (this.app.vault.getAbstractFileByPath(`${old}/reviews`)) {
            new Notice(`Review history in "${old}/reviews" is no longer loaded. Move it into "${folder}/" to keep it.`, 10000);
          }
        });
      });

    new Setting(containerEl)
      .setName("Tag missed exam topics")
      .setDesc("When you import exam results, add weak-area-nbme (or -cms, -amboss…) to the missed topics' notes.")
      .addToggle((t) => t.setValue(s.tagExamMisses).onChange(async (v) => {
        s.tagExamMisses = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName("Review").setHeading();
    new Setting(containerEl).setName("Show intervals on buttons").addToggle((t) =>
      t.setValue(s.showIntervals).onChange(async (v) => {
        s.showIntervals = v;
        await save();
      }),
    );
    new Setting(containerEl).setName("Show remaining card count").addToggle((t) =>
      t.setValue(s.showRemaining).onChange(async (v) => {
        s.showRemaining = v;
        await save();
      }),
    );
    new Setting(containerEl)
      .setName("Show the review heatmap under the deck list")
      .setDesc("Like Anki's Review Heatmap add-on. The full graphs are under Statistics.")
      .addToggle((t) =>
        t.setValue(s.showHeatmap).onChange(async (v) => {
          s.showHeatmap = v;
          await save();
        }),
      );
    num(
      "Reveal answers one by one (🦴)",
      "When a card asks for at least this many answers, the back hides each one as 🦴 (a list on separate lines inside one cloze counts as several answers). N reveals the next, a click reveals that one, comma reveals all. 0 turns it off. The bone button above a card switches that one card on or off.",
      () => s.oneByOneMin,
      (v) => (s.oneByOneMin = v),
      (v) => Number.isInteger(v) && v >= 0,
    );
    new Setting(containerEl)
      .setName("Adaptive new cards")
      .setDesc("Hold new cards back while you are still relearning a lot of cards today, and bring them back as you clear them. Off: new cards follow each deck's daily limit only, as in Anki.")
      .addToggle((t) =>
        t.setValue(s.adaptiveNew).onChange(async (v) => {
          s.adaptiveNew = v;
          await save();
        }),
      );
    num(
      "Adaptive new cards: pause above this many cards in learning",
      "Only used when Adaptive new cards is on. Default: 20.",
      () => s.adaptiveNewPile,
      (v) => (s.adaptiveNewPile = v),
      (v) => Number.isInteger(v) && v > 0,
    );
    num(
      "Rest a card after this many misses in one day",
      "After this many Again answers in a day, the card waits until tomorrow instead of coming round again, and shows under Weak spots on the deck list. 0 turns it off (Anki keeps repeating).",
      () => s.restAfterMisses,
      (v) => (s.restAfterMisses = v),
      (v) => Number.isInteger(v) && v >= 0,
    );
    new Setting(containerEl)
      .setName("Warn when pictures aren't downloaded")
      .setDesc("When Osteon starts, it reads a few pictures to check they are on this device. iCloud can offload them from a phone, which makes cards and notes with pictures hang.")
      .addToggle((t) =>
        t.setValue(s.checkDownloads).onChange(async (v) => {
          s.checkDownloads = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Shortcut note")
      .setDesc("Opening this note opens the deck list instead. Bookmark it, or point an Obsidian home-screen widget at it, to get to your cards in one tap. Give a path such as “Flashcards.md”; leave empty to turn this off (do that to edit the note itself).")
      .addText((t) =>
        t
          .setPlaceholder("Flashcards.md")
          .setValue(s.homeNote)
          .onChange(async (v) => {
            s.homeNote = v.trim();
            await save();
          }),
      )
      .addButton((b) =>
        b.setButtonText("Create the note").onClick(async () => {
          const path = normalizePath(/\.md$/i.test(s.homeNote) ? s.homeNote : `${s.homeNote || "Flashcards"}.md`);
          s.homeNote = path;
          await save();
          if (!this.app.vault.getAbstractFileByPath(path)) {
            await this.app.vault.create(path, "This note is a shortcut: opening it opens the Osteon deck list.\nTo change that, see Settings → Osteon → Shortcut note.\n");
          }
          new Notice(`Shortcut note: ${path}`);
          this.display();
        }),
      );
    num("Card font size (px)", "", () => s.fontSize, (v) => (s.fontSize = v), (v) => v >= 10 && v <= 48);
    this.themeSettings(containerEl, save);
    this.gamepadSettings(containerEl, save);
    new Setting(containerEl)
      .setName("Tap to answer (phone)")
      .setDesc("On the answer side, tap the right third of the screen for Good and the left third for Again, like AnkiMobile. On one-by-one cards the right side reveals the next answer first.")
      .addToggle((t) =>
        t.setValue(s.tapToAnswer).onChange(async (v) => {
          s.tapToAnswer = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Shake to undo (phone)")
      .setDesc("Shake the phone to undo the last answer, like AnkiMobile. iOS asks for motion access the first time.")
      .addToggle((t) =>
        t.setValue(s.shakeToUndo).onChange(async (v) => {
          s.shakeToUndo = v;
          await save();
        }),
      );
    num("Next day starts at (hour)", "Anki default: 4 (4 am)", () => s.dayStartHour, (v) => (s.dayStartHour = v), (v) => Number.isInteger(v) && v >= 0 && v <= 23);
    num("Learn-ahead limit (minutes)", "Anki default: 20", () => s.learnAheadMins, (v) => (s.learnAheadMins = v), (v) => v >= 0);

    new Setting(containerEl)
      .setName("Review keys")
      .setDesc("Separate several keys with commas. Examples: 1, Space, Enter, Mod+z (Cmd or Ctrl), Mod+Shift+D, Escape.")
      .setHeading();
    for (const action of Object.keys(ACTIONS) as ActionName[]) {
      new Setting(containerEl).setName(ACTIONS[action]).addText((t) =>
        t
          .setPlaceholder(DEFAULT_KEYS[action].join(", "))
          .setValue(s.keys[action].join(", "))
          .onChange((v) => {
            s.keys[action] = v.split(",").map(normaliseKey).filter(Boolean);
            this.plugin.saveSettingsSoon();
          }),
      );
    }
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Reset keys to Anki defaults").onClick(async () => {
        s.keys = { ...DEFAULT_KEYS };
        await save();
        this.display();
      }),
    );

    new Setting(containerEl).setName("Medical-term hover").setHeading();
    new Setting(containerEl)
      .setName("Underline terms")
      .setDesc("Terms on the card are underlined; hover (Mac) or tap (iPhone) for a definition. 'Hard terms only' works like AMBOSS: basic words like pelvis or fracture aren't underlined. Your own notes' titles always are.")
      .addDropdown((d) =>
        d
          .addOption("strict", "Hard terms only (like AMBOSS)")
          .addOption("uncommon", "Uncommon words")
          .addOption("all", "All medical terms")
          .addOption("off", "Off")
          .setValue(s.hover.sensitivity)
          .onChange(async (v) => {
            s.hover.sensitivity = v as typeof s.hover.sensitivity;
            await save();
            this.plugin.terms.rebuildSoon();
          }),
      );
    new Setting(containerEl)
      .setName("Also on the front of cards")
      .setDesc("Off by default: a definition can give away the answer.")
      .addToggle((t) =>
        t.setValue(s.hover.onFront).onChange(async (v) => {
          s.hover.onFront = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Also in notes (reading view)")
      .addToggle((t) =>
        t.setValue(s.hover.inNotes).onChange(async (v) => {
          s.hover.inNotes = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Use my notes")
      .setDesc("A note whose title or alias matches a term gives the definition (its first paragraph and pictures).")
      .addToggle((t) =>
        t.setValue(s.hover.useNotes).onChange(async (v) => {
          s.hover.useNotes = v;
          await save();
          this.plugin.terms.rebuildSoon();
        }),
      );
    new Setting(containerEl)
      .setName("My terms list")
      .setDesc(`Your own definitions and a never-underline list: ${s.stateFolder}/glossary/My terms.md`)
      .addButton((b) => b.setButtonText("Open").onClick(() => void this.plugin.terms.openMyTerms()));
    const meshStatus = this.plugin.terms.meshStatus();
    new Setting(containerEl)
      .setName("MeSH dictionary")
      .setDesc(
        `The U.S. National Library of Medicine's medical vocabulary, free with attribution. Downloaded once per device (about 30 MB) and kept on the device, not in the vault. ${meshStatus}`,
      )
      .addToggle((t) =>
        t.setValue(s.hover.useMesh).onChange(async (v) => {
          s.hover.useMesh = v;
          await save();
          this.plugin.terms.rebuildSoon();
        }),
      )
      .addButton((b) =>
        b.setButtonText(this.plugin.terms.hasMesh() ? "Update" : "Download").onClick(async () => {
          b.setDisabled(true);
          await this.plugin.terms.downloadMesh();
          this.display();
        }),
      );

    new Setting(containerEl).setName("AI helpers").setHeading();
    const provider = s.ai.provider;
    const keyId = aiKeyId(provider);
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Optional. Uses your own API key from the provider you choose (billed by that provider), or a model running on your own computer. " +
        "When on, card text is sent to that provider to find hard terms and write short definitions (cached in the vault, " +
        "so each card is looked at once), to explain cards you keep missing, and to suggest splits for overstuffed cards.",
    });
    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Each provider keeps its own key. “Other” works with any service that accepts OpenAI-style requests, including Ollama and LM Studio.")
      .addDropdown((d) => {
        for (const [id, p] of Object.entries(AI_PROVIDERS)) d.addOption(id, p.label);
        d.setValue(provider).onChange(async (v) => {
          s.ai.provider = v as AiProvider;
          if (!s.ai.otherModel.trim()) s.ai.otherModel = AI_PROVIDERS[s.ai.provider].model ?? "";
          await save();
          if (s.ai.syncKey) await writeKeyFile(this.app, this.plugin.manifest.dir ?? "", getSecret(this.app, aiKeyId(s.ai.provider)));
          this.display();
        });
      });
    if (provider === "custom") {
      new Setting(containerEl)
        .setName("Server address")
        .setDesc("The base address of the service, e.g. http://localhost:11434/v1 for Ollama.")
        .addText((t) => {
          t.setPlaceholder("https://…/v1").setValue(s.ai.baseUrl);
          t.inputEl.addEventListener("change", async () => {
            s.ai.baseUrl = t.getValue().trim();
            await save();
          });
        });
    }
    new Setting(containerEl)
      .setName("API key")
      .setDesc("Stored on this device only, never in the vault, unless “Sync the key to my other devices” below is on.")
      .addText((t) => {
        t.inputEl.type = "password";
        const placeholder = () => (getSecret(this.app, keyId) ? "•••••••• (saved)" : AI_PROVIDERS[provider].keyHint);
        t.setPlaceholder(placeholder());
        t.inputEl.addEventListener("change", () => {
          setSecret(this.app, keyId, t.getValue().trim());
          t.setValue("");
          t.setPlaceholder(placeholder());
          const key = getSecret(this.app, keyId);
          if (s.ai.syncKey) void writeKeyFile(this.app, this.plugin.manifest.dir ?? "", key);
          new Notice(key ? (s.ai.syncKey ? "API key saved, and synced to your other devices." : "API key saved on this device.") : "API key removed.");
        });
      });
    new Setting(containerEl)
      .setName("Sync the key to my other devices")
      .setDesc(
        "Keeps a copy of the key in a file in this vault's plugin folder, so your phone or second computer picks it up without typing it. " +
          "Anyone who gets a copy of the vault's hidden settings folder gets the key too, so leave this off for a vault you share. Turning it off deletes the file.",
      )
      .addToggle((t) =>
        t.setValue(s.ai.syncKey).onChange(async (v) => {
          s.ai.syncKey = v;
          await save();
          await writeKeyFile(this.app, this.plugin.manifest.dir ?? "", v ? getSecret(this.app, keyId) : "");
          if (v && !getSecret(this.app, keyId)) new Notice("Enter the key on this device, or wait for it to arrive from another one.");
        }),
      );
    new Setting(containerEl).setName("Use AI").addToggle((t) =>
      t.setValue(s.ai.enabled).onChange(async (v) => {
        s.ai.enabled = v;
        await save();
      }),
    );
    if (provider === "anthropic") {
      new Setting(containerEl)
        .setName("Model")
        .setDesc("Opus 5 is the most capable; Haiku 4.5 costs about a fifth as much.")
        .addDropdown((d) =>
          d
            .addOption("claude-opus-5", "Claude Opus 5")
            .addOption("claude-sonnet-5", "Claude Sonnet 5")
            .addOption("claude-haiku-4-5", "Claude Haiku 4.5")
            .setValue(s.ai.model)
            .onChange(async (v) => {
              s.ai.model = v as typeof s.ai.model;
              await save();
            }),
        );
    } else {
      new Setting(containerEl)
        .setName("Model")
        .setDesc(
          (s.ai.otherModel.trim() ? "" : "Needed before the AI helpers can run. ") +
            "The model's name exactly as your provider lists it. A small, inexpensive model is enough for definitions.",
        )
        .addText((t) => {
          t.setPlaceholder("model name").setValue(s.ai.otherModel);
          t.inputEl.addEventListener("change", async () => {
            s.ai.otherModel = t.getValue().trim();
            await save();
          });
        });
    }
    new Setting(containerEl)
      .setName("Never send cards from these folders")
      .setDesc("Comma-separated.")
      .addText((t) => {
        t.setValue(s.ai.excludeFolders.join(", "));
        t.inputEl.addEventListener("change", async () => {
          s.ai.excludeFolders = t.getValue().split(",").map((x) => x.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
          await save();
        });
      });
    new Setting(containerEl)
      .setName("Look at new cards automatically")
      .setDesc("In small batches (up to 30 cards) while Obsidian is open. Larger runs always ask first.")
      .addToggle((t) =>
        t.setValue(s.ai.autoRun).onChange(async (v) => {
          s.ai.autoRun = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Find hard terms now")
      .setDesc(this.plugin.ai.statusText())
      .addButton((b) => b.setButtonText("Run").onClick(() => void this.plugin.ai.runWithConfirm()));

    containerEl.createDiv({ cls: "setting-item-description", text: `Installed version: ${this.plugin.manifest.version}` });
  }
}

/** Apply a card theme to the review screen's card element (class + background picture). */
export function applyCardTheme(app: App, root: HTMLElement, card: HTMLElement, s: FlashcardsSettings): void {
  for (const k of Object.keys(CARD_THEMES)) root.removeClass(`fc-theme-${k}`);
  root.addClass(`fc-theme-${s.cardTheme}`);
  card.setCssStyles({ backgroundImage: "" });
  if (s.cardTheme !== "image" || !s.cardBackground) return;
  const file = app.metadataCache.getFirstLinkpathDest(s.cardBackground, "") ?? app.vault.getFileByPath(s.cardBackground);
  if (!file) return;
  const dim = Math.min(0.9, Math.max(0, s.cardBackgroundDim));
  card.style.backgroundImage = `linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), url("${app.vault.getResourcePath(file)}")`;
}

/** A small sample card (front and back) in the chosen theme, for the settings tab. */
export function renderThemeSample(app: App, el: HTMLElement, s: FlashcardsSettings): void {
  const root = el.createDiv({ cls: "fc-review fc-theme-sample" });
  const card = root.createDiv({ cls: "fc-card" });
  card.style.fontSize = `${Math.round(s.fontSize * 0.85)}px`;
  const q = card.createDiv({ cls: "fc-question markdown-rendered" });
  q.appendText("The ACL originates on the ");
  q.createSpan({ cls: "fc-cloze", text: "[...]" });
  q.appendText(".");
  card.createEl("hr", { cls: "fc-answer-rule" });
  const a = card.createDiv({ cls: "fc-question markdown-rendered" });
  a.appendText("The ACL originates on the ");
  a.createEl("mark", { text: "lateral femoral condyle" });
  a.appendText(".");
  card.createDiv({ cls: "fc-extra", text: "Posterior part of the notch wall, behind the resident's ridge." });
  applyCardTheme(app, root, card, s);
}
