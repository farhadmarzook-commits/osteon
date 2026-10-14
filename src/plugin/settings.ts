import type { DeckRename } from "../core/collection";
import { App, normalizePath, Notice, PluginSettingTab, requireApiVersion, Setting } from "obsidian";
import type { SettingDefinition, SettingDefinitionGroup, SettingGroup } from "obsidian";
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

/** What shows for a moment after an answer (review screen). */
export const ANSWER_FEEDBACK = {
  off: "Nothing",
  line: "Thin coloured line",
  dot: "Coloured dot",
  word: "Small word",
  pill: "Bold label",
} as const;
export type AnswerFeedback = keyof typeof ANSWER_FEEDBACK;

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
  /** How the answer just given (Again, Hard, Good, Easy) shows for a moment, so a key press or tap is seen to register. */
  answerFeedback: AnswerFeedback;
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
  answerFeedback: "word",
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
    });
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
    cardNotes: s.cardNotes && typeof s.cardNotes === "object" ? (s.cardNotes) : {},
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
    answerFeedback: s.answerFeedback && s.answerFeedback in ANSWER_FEEDBACK ? s.answerFeedback : "word",
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
/** Run an async handler when a text box is changed, without handing the event system a promise. */
function onChange(el: HTMLElement, fn: () => Promise<void>): void {
  el.addEventListener("change", () => void fn());
}

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

/** Read a setting by its key; a dot reaches into a nested group ("ai.enabled"). */
export function getSettingPath(settings: object, key: string): unknown {
  let at: unknown = settings;
  for (const part of key.split(".")) {
    if (at === null || typeof at !== "object" || !Object.prototype.hasOwnProperty.call(at, part)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/** Write a setting by its key. A key that isn't a setting is refused, not created (false). */
export function setSettingPath(settings: object, key: string, value: unknown): boolean {
  const parts = key.split(".");
  const last = parts.pop() ?? "";
  const parent = parts.length ? getSettingPath(settings, parts.join(".")) : settings;
  if (parent === null || typeof parent !== "object" || !Object.prototype.hasOwnProperty.call(parent, last)) return false;
  (parent as Record<string, unknown>)[last] = value;
  return true;
}

type Row = SettingDefinition;
/** A headed section of the tab. */
interface Section extends SettingDefinitionGroup {
  type: "group";
  items: Row[];
}

/**
 * The settings tab, as a list of definitions (Obsidian 1.13 draws and searches them). A plain on/off
 * or choice is a `control` bound to its settings key; anything with a side effect, a button or its
 * own layout is a `render` row. Before 1.13, `display()` draws the same list by hand.
 *
 * Obsidian asks for the list once, when the plugin loads, and again only on `update()`; it runs the
 * `render` rows each time the tab opens. So anything that can change (values, status text) is read
 * inside `render`, and a row's name must be unique in its section (Obsidian matches rows by it).
 */
export class FlashcardsSettingTab extends PluginSettingTab {
  /** The theme sample's holder while it is on screen, so the theme rows can redraw it. */
  private sample: HTMLElement | null = null;
  /** Before 1.13: the rows that come and go, so they can be shown and hidden in place. */
  private legacyRows: Array<{ el: HTMLElement; visible: () => boolean }> = [];

  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
  ) {
    super(app, plugin);
  }

  hide(): void {
    this.plugin.saveSettingsSoon.run();
    super.hide();
  }

  getControlValue(key: string): unknown {
    return getSettingPath(this.plugin.settings, key);
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (setSettingPath(this.plugin.settings, key, value)) await this.plugin.saveSettings();
  }

  /** Draw every row again (for rows whose text depends on what was just changed). */
  private redraw(): void {
    if (requireApiVersion("1.13.0")) this.update();
    else this.drawLegacy();
  }

  /** Show or hide the rows that depend on another setting (the background picture rows). */
  private refreshVisible(): void {
    if (requireApiVersion("1.13.0")) this.refreshDomState();
    else for (const row of this.legacyRows) row.el.toggle(row.visible());
  }

  private drawSample(): void {
    if (!this.sample) return;
    this.sample.empty();
    renderThemeSample(this.app, this.sample, this.plugin.settings);
  }

  /** Obsidian before 1.13 calls this; newer versions draw from `getSettingDefinitions()` and skip it. */
  display(): void {
    this.drawLegacy();
  }

  private drawLegacy(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.legacyRows = [];
    const draw = (def: Row) => {
      const setting = new Setting(containerEl).setName(def.name);
      if (def.desc) setting.setDesc(def.desc);
      const { visible, control } = def;
      if (typeof visible === "function") {
        this.legacyRows.push({ el: setting.settingEl, visible });
        setting.settingEl.toggle(visible());
      }
      // No row here uses the group argument (setting groups came with 1.11).
      if (def.render) def.render(setting, null as unknown as SettingGroup);
      else if (control?.type === "toggle") {
        setting.addToggle((t) => t.setValue(this.getControlValue(control.key) === true).onChange((v) => void this.setControlValue(control.key, v)));
      } else if (control?.type === "dropdown") {
        setting.addDropdown((d) =>
          d
            .addOptions(control.options)
            .setValue(String(this.getControlValue(control.key)))
            .onChange((v) => void this.setControlValue(control.key, v)),
        );
      }
    };
    for (const item of this.getSettingDefinitions()) {
      if (!("type" in item)) {
        draw(item);
        continue;
      }
      if (item.heading) new Setting(containerEl).setName(item.heading).setHeading();
      item.items.forEach(draw);
    }
  }

  /** Game controller: on/off, a button tester, and the bindings per side (like Contanki). */
  private gamepadRows(save: () => Promise<void>): Row[] {
    const s = this.plugin.settings;
    return [
      {
        name: "Use a game controller",
        desc: "Like Anki's Contanki add-on (e.g. an 8BitDo Micro in controller mode). The buttons start with your Anki 8BitDo Micro setup.",
        control: { type: "toggle", key: "gamepad.enabled" },
      },
      {
        name: "Which button is which?",
        desc: "Press Test, then a controller button, to see its number.",
        render: (setting) => {
          setting.addButton((b) =>
            b.setButtonText("Test").onClick(() => {
              b.setButtonText("Press a button…");
              this.plugin.gamepad.listener = (n) => {
                this.plugin.gamepad.listener = null;
                const dir = { 100: " (left)", 101: " (right)", 102: " (up)", 103: " (down)" }[n as 100] ?? "";
                b.setButtonText(`Button ${n}${dir}`);
              };
            }),
          );
        },
      },
      {
        name: "Buttons",
        desc: "What each controller button does on the question side, the answer side and the deck list.",
        render: (setting) => {
          setting.settingEl.addClass("fc-setting-stack");
          const table = setting.settingEl.createEl("table", { cls: "fc-pad-table fc-setting-wide" });
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
          setting
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
          // Drawing the row again only clears its controls, so take the table away with it.
          return () => table.remove();
        },
      },
    ];
  }

  /** Card theme dropdown with a live sample card (and the background picture options). */
  private themeRows(save: () => Promise<void>): Row[] {
    const s = this.plugin.settings;
    const picture = () => s.cardTheme === "image";
    return [
      {
        name: "Card theme",
        desc: "How cards look while you review. The sample below updates as you choose.",
        render: (setting) => {
          setting.addDropdown((d) => {
            for (const [k, label] of Object.entries(CARD_THEMES)) d.addOption(k, label);
            d.setValue(s.cardTheme).onChange(async (v) => {
              s.cardTheme = v as CardTheme;
              await save();
              this.refreshVisible();
              this.drawSample();
            });
          });
        },
      },
      {
        name: "Background picture",
        desc: "A picture in your vault, e.g. Attachments/Background.jpg",
        visible: picture,
        render: (setting) => {
          setting.addText((t) =>
            t.setValue(s.cardBackground).onChange(async (v) => {
              s.cardBackground = v.trim().replace(/^!?\[\[|\]\]$/g, "");
              await save();
              this.drawSample();
            }),
          );
        },
      },
      {
        name: "Dim the picture",
        desc: "Darker keeps the text readable.",
        visible: picture,
        render: (setting) => {
          // Obsidian 1.13 shows the value beside the slider; before that it is written out here.
          const shown = requireApiVersion("1.13.0") ? null : setting.controlEl.createSpan({ text: String(s.cardBackgroundDim) });
          setting.addSlider((sl) =>
            sl
              .setLimits(0, 0.9, 0.05)
              .setValue(s.cardBackgroundDim)
              .onChange(async (v) => {
                s.cardBackgroundDim = v;
                shown?.setText(String(v));
                await save();
                this.drawSample();
              }),
          );
        },
      },
      {
        name: "Sample card",
        searchable: false,
        render: (setting) => {
          setting.settingEl.addClass("fc-setting-stack");
          const holder = setting.settingEl.createDiv({ cls: "fc-setting-wide" });
          this.sample = holder;
          this.drawSample();
          return () => {
            holder.remove();
            if (this.sample === holder) this.sample = null;
          };
        },
      },
    ];
  }

  getSettingDefinitions(): Array<Row | Section> {
    const s = this.plugin.settings;
    const save = async () => this.plugin.saveSettings();
    const keyId = () => aiKeyId(s.ai.provider);
    const folders = (v: string) => v.split(",").map((x) => x.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);

    const toggle = (name: string, desc: string, key: string): Row => ({ name, desc: desc || undefined, control: { type: "toggle", key } });
    const num = (name: string, desc: string, get: () => number, set: (v: number) => void, valid: (v: number) => boolean): Row => ({
      name,
      desc: desc || undefined,
      render: (setting) => {
        setting.addText((t) =>
          t.setValue(String(get())).onChange((v) => {
            if (v.trim() === "") return;
            const n = Number(v);
            if (!Number.isFinite(n) || !valid(n)) return;
            set(n);
            this.plugin.saveSettingsSoon();
          }),
        );
      },
    });

    const decks: Section = {
      type: "group",
      heading: "Decks",
      items: [
        {
          name: "Presets",
          desc:
            "Daily limits, learning steps, desired retention and more live in presets, as in Anki. " +
            "Open a deck's options from the gear icon in the deck list; this edits the Default preset.",
          render: (setting) => {
            setting.addButton((b) => b.setButtonText("Edit Default preset").onClick(() => new DeckOptionsModal(this.app, this.plugin, null).open()));
          },
        },
      ],
    };

    const cards: Section = {
      type: "group",
      heading: "Cards",
      items: [
        // Folder settings re-scan the vault, so they apply when the field loses focus, not per keystroke.
        {
          name: "Card folders",
          desc: "Notes tagged #flashcards are always scanned. Also scan every note in these folders (comma-separated).",
          render: (setting) => {
            setting.addText((t) => {
              t.setValue(s.cardFolders.join(", "));
              onChange(t.inputEl, async () => {
                s.cardFolders = folders(t.getValue());
                await this.plugin.applyFolderSettings();
              });
            });
          },
        },
        {
          name: "Review data folder",
          desc:
            "Where review history is kept (one sub-folder per device). Must not start with a dot, so it syncs. " +
            "Changing it does not move existing history: move the old folder in the file explorer first.",
          render: (setting) => {
            setting.addText((t) => {
              t.setValue(s.stateFolder);
              onChange(t.inputEl, async () => {
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
          },
        },
        toggle("Tag missed exam topics", "When you import exam results, add weak-area-nbme (or -cms, -amboss…) to the missed topics' notes.", "tagExamMisses"),
      ],
    };

    const review: Section = {
      type: "group",
      heading: "Review",
      items: [
        toggle("Show intervals on buttons", "", "showIntervals"),
        toggle("Show remaining card count", "", "showRemaining"),
        toggle("Show the review heatmap under the deck list", "Like Anki's Review Heatmap add-on. The full graphs are under Statistics.", "showHeatmap"),
        num(
          "Reveal answers one by one (🦴)",
          "When a card asks for at least this many answers, the back hides each one as 🦴 (a list on separate lines inside one cloze counts as several answers). N reveals the next, a click reveals that one, comma reveals all. 0 turns it off. The bone button above a card switches that one card on or off.",
          () => s.oneByOneMin,
          (v) => (s.oneByOneMin = v),
          (v) => Number.isInteger(v) && v >= 0,
        ),
        toggle(
          "Adaptive new cards",
          "Hold new cards back while you are still relearning a lot of cards today, and bring them back as you clear them. Off: new cards follow each deck's daily limit only, as in Anki.",
          "adaptiveNew",
        ),
        num(
          "Adaptive new cards: pause above this many cards in learning",
          "Only used when Adaptive new cards is on. Default: 20.",
          () => s.adaptiveNewPile,
          (v) => (s.adaptiveNewPile = v),
          (v) => Number.isInteger(v) && v > 0,
        ),
        num(
          "Rest a card after this many misses in one day",
          "After this many Again answers in a day, the card waits until tomorrow instead of coming round again, and shows under Weak spots on the deck list. 0 turns it off (Anki keeps repeating).",
          () => s.restAfterMisses,
          (v) => (s.restAfterMisses = v),
          (v) => Number.isInteger(v) && v >= 0,
        ),
        toggle(
          "Warn when pictures aren't downloaded",
          "When Osteon starts, it reads a few pictures to check they are on this device. iCloud can offload them from a phone, which makes cards and notes with pictures hang.",
          "checkDownloads",
        ),
        {
          name: "Shortcut note",
          desc: "Opening this note opens the deck list instead. Bookmark it, or point an Obsidian home-screen widget at it, to get to your cards in one tap. Give a path such as “Flashcards.md”; leave empty to turn this off (do that to edit the note itself).",
          render: (setting) => {
            setting
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
                  this.redraw();
                }),
              );
          },
        },
        num("Card font size (px)", "", () => s.fontSize, (v) => (s.fontSize = v), (v) => v >= 10 && v <= 48),
        ...this.themeRows(save),
      ],
    };

    // The phone and timing rows have always followed the controller's, under its heading.
    const controller: Section = {
      type: "group",
      heading: "Game controller",
      items: [
        ...this.gamepadRows(save),
        toggle(
          "Tap to answer (phone)",
          "On the answer side, tap the right third of the screen for Good and the left third for Again, like AnkiMobile. On one-by-one cards the right side reveals the next answer first.",
          "tapToAnswer",
        ),
        {
          name: "Show what you answered",
          desc: "After each answer, a brief sign just above the answer buttons shows that the key or tap registered and which answer it was (red Again, grey Hard, green Good, blue Easy).",
          control: { type: "dropdown", key: "answerFeedback", options: ANSWER_FEEDBACK },
        },
        toggle("Shake to undo (phone)", "Shake the phone to undo the last answer, like AnkiMobile. iOS asks for motion access the first time.", "shakeToUndo"),
        num("Next day starts at (hour)", "Anki default: 4 (4 am)", () => s.dayStartHour, (v) => (s.dayStartHour = v), (v) => Number.isInteger(v) && v >= 0 && v <= 23),
        num("Learn-ahead limit (minutes)", "Anki default: 20", () => s.learnAheadMins, (v) => (s.learnAheadMins = v), (v) => v >= 0),
      ],
    };

    const keys: Section = {
      type: "group",
      heading: "Review keys",
      items: [
        { name: "Separate several keys with commas", desc: "Examples: 1, Space, Enter, Mod+z (Cmd or Ctrl), Mod+Shift+D, Escape." },
        ...(Object.keys(ACTIONS) as ActionName[]).map(
          (action): Row => ({
            name: ACTIONS[action],
            render: (setting) => {
              setting.addText((t) =>
                t
                  .setPlaceholder(DEFAULT_KEYS[action].join(", "))
                  .setValue(s.keys[action].join(", "))
                  .onChange((v) => {
                    s.keys[action] = v.split(",").map(normaliseKey).filter(Boolean);
                    this.plugin.saveSettingsSoon();
                  }),
              );
            },
          }),
        ),
        {
          name: "Reset keys to Anki defaults",
          render: (setting) => {
            setting.addButton((b) =>
              b.setButtonText("Reset").onClick(async () => {
                s.keys = { ...DEFAULT_KEYS };
                await save();
                this.redraw();
              }),
            );
          },
        },
      ],
    };

    const meshDesc = "The U.S. National Library of Medicine's medical vocabulary, free with attribution. Downloaded once per device (about 30 MB) and kept on the device, not in the vault.";
    const hover: Section = {
      type: "group",
      heading: "Medical-term hover",
      items: [
        {
          name: "Underline terms",
          desc: "Terms on the card are underlined; hover (Mac) or tap (iPhone) for a definition. 'Hard terms only' works like AMBOSS: basic words like pelvis or fracture aren't underlined. Your own notes' titles always are.",
          render: (setting) => {
            setting.addDropdown((d) =>
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
          },
        },
        toggle("Also on the front of cards", "Off by default: a definition can give away the answer.", "hover.onFront"),
        toggle("Also in notes (reading view)", "", "hover.inNotes"),
        {
          name: "Use my notes",
          desc: "A note whose title or alias matches a term gives the definition (its first paragraph and pictures).",
          render: (setting) => {
            setting.addToggle((t) =>
              t.setValue(s.hover.useNotes).onChange(async (v) => {
                s.hover.useNotes = v;
                await save();
                this.plugin.terms.rebuildSoon();
              }),
            );
          },
        },
        {
          name: "My terms list",
          desc: "Your own definitions and a never-underline list.",
          render: (setting) => {
            setting.setDesc(`Your own definitions and a never-underline list: ${s.stateFolder}/glossary/My terms.md`).addButton((b) => b.setButtonText("Open").onClick(() => void this.plugin.terms.openMyTerms()));
          },
        },
        {
          name: "MeSH dictionary",
          desc: meshDesc,
          render: (setting) => {
            setting
              .setDesc(`${meshDesc} ${this.plugin.terms.meshStatus()}`)
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
                  this.redraw();
                }),
              );
          },
        },
      ],
    };

    const modelDesc = "The model's name exactly as your provider lists it. A small, inexpensive model is enough for definitions.";
    const ai: Section = {
      type: "group",
      heading: "AI helpers",
      items: [
        {
          name: "Optional",
          desc:
            "Uses your own API key from the provider you choose (billed by that provider), or a model running on your own computer. " +
            "When on, card text is sent to that provider to find hard terms and write short definitions (cached in the vault, " +
            "so each card is looked at once), to explain cards you keep missing, and to suggest splits for overstuffed cards.",
        },
        {
          name: "Provider",
          desc: "Each provider keeps its own key. “Other” works with any service that accepts OpenAI-style requests, including Ollama and LM Studio.",
          render: (setting) => {
            setting.addDropdown((d) => {
              for (const [id, p] of Object.entries(AI_PROVIDERS)) d.addOption(id, p.label);
              d.setValue(s.ai.provider).onChange(async (v) => {
                s.ai.provider = v as AiProvider;
                if (!s.ai.otherModel.trim()) s.ai.otherModel = AI_PROVIDERS[s.ai.provider].model ?? "";
                await save();
                if (s.ai.syncKey) await writeKeyFile(this.app, this.plugin.manifest.dir ?? "", getSecret(this.app, keyId()));
                // The key, server and model rows all follow the provider.
                this.redraw();
              });
            });
          },
        },
        {
          name: "Server address",
          desc: "The base address of the service, e.g. http://localhost:11434/v1 for Ollama.",
          visible: () => s.ai.provider === "custom",
          render: (setting) => {
            setting.addText((t) => {
              t.setPlaceholder("https://…/v1").setValue(s.ai.baseUrl);
              onChange(t.inputEl, async () => {
                s.ai.baseUrl = t.getValue().trim();
                await save();
              });
            });
          },
        },
        {
          name: "API key",
          desc: "Stored on this device only, never in the vault, unless “Sync the key to my other devices” below is on.",
          render: (setting) => {
            setting.addText((t) => {
              t.inputEl.type = "password";
              const placeholder = () => (getSecret(this.app, keyId()) ? "•••••••• (saved)" : AI_PROVIDERS[s.ai.provider].keyHint);
              t.setPlaceholder(placeholder());
              t.inputEl.addEventListener("change", () => {
                setSecret(this.app, keyId(), t.getValue().trim());
                t.setValue("");
                t.setPlaceholder(placeholder());
                const key = getSecret(this.app, keyId());
                if (s.ai.syncKey) void writeKeyFile(this.app, this.plugin.manifest.dir ?? "", key);
                new Notice(key ? (s.ai.syncKey ? "API key saved, and synced to your other devices." : "API key saved on this device.") : "API key removed.");
              });
            });
          },
        },
        {
          name: "Sync the key to my other devices",
          desc:
            "Keeps a copy of the key in a file in this vault's plugin folder, so your phone or second computer picks it up without typing it. " +
            "Anyone who gets a copy of the vault's hidden settings folder gets the key too, so leave this off for a vault you share. Turning it off deletes the file.",
          render: (setting) => {
            setting.addToggle((t) =>
              t.setValue(s.ai.syncKey).onChange(async (v) => {
                s.ai.syncKey = v;
                await save();
                await writeKeyFile(this.app, this.plugin.manifest.dir ?? "", v ? getSecret(this.app, keyId()) : "");
                if (v && !getSecret(this.app, keyId())) new Notice("Enter the key on this device, or wait for it to arrive from another one.");
              }),
            );
          },
        },
        toggle("Use AI", "", "ai.enabled"),
        {
          name: "Model",
          desc: "Opus 5 is the most capable; Haiku 4.5 costs about a fifth as much.",
          visible: () => s.ai.provider === "anthropic",
          control: {
            type: "dropdown",
            key: "ai.model",
            options: { "claude-opus-5": "Claude Opus 5", "claude-sonnet-5": "Claude Sonnet 5", "claude-haiku-4-5": "Claude Haiku 4.5" } satisfies Record<AiModel, string>,
          },
        },
        {
          name: "Model",
          desc: modelDesc,
          visible: () => s.ai.provider !== "anthropic",
          render: (setting) => {
            if (!s.ai.otherModel.trim()) setting.setDesc(`Needed before the AI helpers can run. ${modelDesc}`);
            setting.addText((t) => {
              t.setPlaceholder("Model name").setValue(s.ai.otherModel);
              onChange(t.inputEl, async () => {
                s.ai.otherModel = t.getValue().trim();
                await save();
              });
            });
          },
        },
        {
          name: "Never send cards from these folders",
          desc: "Comma-separated.",
          render: (setting) => {
            setting.addText((t) => {
              t.setValue(s.ai.excludeFolders.join(", "));
              onChange(t.inputEl, async () => {
                s.ai.excludeFolders = folders(t.getValue());
                await save();
              });
            });
          },
        },
        toggle("Look at new cards automatically", "In small batches (up to 30 cards) while Obsidian is open. Larger runs always ask first.", "ai.autoRun"),
        {
          name: "Find hard terms now",
          render: (setting) => {
            setting.setDesc(this.plugin.ai.statusText()).addButton((b) => b.setButtonText("Run").onClick(() => void this.plugin.ai.runWithConfirm()));
          },
        },
      ],
    };

    return [decks, cards, review, controller, keys, hover, ai, { name: "Installed version", desc: this.plugin.manifest.version, searchable: false }];
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
