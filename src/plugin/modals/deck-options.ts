/** Anki's deck options screen, with presets shared between decks (spec 0003 §4). */
import { App, Modal, Notice, Setting } from "obsidian";
import { DEFAULT_PRESET_ID, defaultPreset, newPresetId, presetIdFor, type Preset } from "../../core/presets";
import { MIN_REVIEWS_TO_OPTIMIZE, optimize, sequencesFrom } from "../../core/optimizer";
import { parseSteps } from "../../core/scheduler";
import type FlashcardsPlugin from "../../main";
import { destructive } from "../compat";

export class DeckOptionsModal extends Modal {
  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    /** The deck whose options are shown, or null to edit the Default preset. */
    private deck: string | null,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.plugin.saveSettingsSoon.run();
    this.contentEl.empty();
  }

  /**
   * Anki's "Optimize" (spec 0013): fit FSRS parameters to the review history of every card that
   * uses this preset, show how much better they predict it, and apply them on request.
   */
  private optimizeRow(contentEl: HTMLElement, p: Preset, presetId: string): void {
    const s = this.plugin.settings;
    const histories: Array<ReadonlyArray<{ ts: string; rating: string }>> = [];
    for (const i of this.plugin.items(null)) {
      if (!i.state?.reviews.length) continue;
      if (presetIdFor(i.ref.deck, s.deckPresets, s.presets) !== presetId) continue;
      histories.push(i.state.reviews);
    }
    const seqs = sequencesFrom(histories, s.dayStartHour);
    const usable = seqs.reduce((n, q) => n + q.filter((x, k) => k > 0 && x.t > 0).length, 0);
    const row = new Setting(contentEl)
      .setName("Optimize FSRS parameters")
      .setDesc(
        usable >= MIN_REVIEWS_TO_OPTIMIZE
          ? `Fit the parameters to this preset's own history (${usable.toLocaleString()} spaced reviews from ${seqs.length.toLocaleString()} cards). Takes a few seconds.`
          : `Needs at least ${MIN_REVIEWS_TO_OPTIMIZE} spaced reviews in this preset; it has ${usable.toLocaleString()}. Keep the defaults for now.`,
      );
    if (usable < MIN_REVIEWS_TO_OPTIMIZE) return;
    const out = contentEl.createDiv({ cls: "fc-muted fc-optimize-result" });
    row.addButton((b) =>
      b.setButtonText("Optimize").onClick(async () => {
        b.setDisabled(true);
        out.empty();
        const notice = new Notice("Optimizing FSRS parameters… 0%", 0);
        let lastYield = performance.now();
        try {
          const res = await optimize(seqs, p.scheduler.weights.length >= 21 ? p.scheduler.weights : undefined, {
            // Yield to the UI about every 150 ms of work, not every iteration: a hidden window's
            // timers are throttled to a second or more, which made per-iteration yields crawl.
            progress: (f) => {
              if (performance.now() - lastYield < 150) return;
              notice.setMessage(`Optimizing FSRS parameters… ${Math.round(f * 100)}%`);
              return new Promise<void>((r) => window.setTimeout(() => ((lastYield = performance.now()), r()), 0));
            },
          });
          notice.hide();
          const better = ((1 - res.lossAfter / res.lossBefore) * 100).toFixed(1);
          out.createDiv({
            text:
              res.lossAfter < res.lossBefore - 1e-4
                ? `Log loss ${res.lossBefore.toFixed(4)} → ${res.lossAfter.toFixed(4)} (${better}% better fit on ${res.reviews.toLocaleString()} reviews).`
                : `Your current parameters already fit this history (log loss ${res.lossBefore.toFixed(4)}). Nothing to change.`,
          });
          if (res.lossAfter >= res.lossBefore - 1e-4) return;
          out.createEl("code", { text: res.weights.join(", "), cls: "fc-fsrs-params" });
          new Setting(out)
            .setDesc("Using them recalculates every card in this preset from its history, so due dates shift (as when you change FSRS options in Anki).")
            .addButton((u) =>
              u.setButtonText("Use these parameters").setCta().onClick(async () => {
                p.scheduler.weights = res.weights;
                await this.plugin.saveSettings();
                new Notice("New FSRS parameters saved for this preset.");
                this.render();
              }),
            );
        } catch (e) {
          notice.hide();
          console.error("Flashcards: FSRS optimization failed", e);
          out.setText("Optimization failed; see the developer console.");
        } finally {
          b.setDisabled(false);
        }
      }),
    );
  }

  private render(): void {
    const { contentEl } = this;
    const s = this.plugin.settings;
    contentEl.empty();
    this.setTitle(this.deck ? `Options: ${this.deck.split("/").join(" › ")}` : "Default preset");
    const presetId = this.deck ? presetIdFor(this.deck, s.deckPresets, s.presets) : DEFAULT_PRESET_ID;
    const p = s.presets[presetId];
    const save = () => this.plugin.saveSettings();

    if (this.deck) {
      const deck = this.deck;
      new Setting(contentEl)
        .setName("Hide this deck")
        .setDesc("Keeps it off the deck list and out of Study all. Its cards and history stay; Browse still finds them.")
        .addToggle((t) => t.setValue(this.plugin.isDeckHidden(deck)).onChange((v) => void this.plugin.setDeckHidden(deck, v)));
      const deckKey = this.deck.toLowerCase();
      const own = s.deckPresets[deckKey];
      const users = Object.keys(s.deckPresets).filter((d) => s.deckPresets[d] === presetId).length;
      new Setting(contentEl)
        .setName("Preset")
        .setDesc(
          own
            ? `Used by ${users} deck${users === 1 ? "" : "s"}. Changes apply to all of them.`
            : "Inherited from a parent deck (or Default). Choosing a preset here overrides it for this deck and its sub-decks.",
        )
        .addDropdown((d) => {
          for (const x of Object.values(s.presets)) d.addOption(x.id, x.name);
          d.setValue(presetId).onChange(async (v) => {
            s.deckPresets[deckKey] = v;
            await save();
            this.render();
          });
        })
        .addButton((b) =>
          b.setButtonText("Save to all subdecks").onClick(async () => {
            // Anki's "Save to All Subdecks": sub-decks drop their own presets and use this one.
            let n = 0;
            for (const d of Object.keys(s.deckPresets)) {
              if (d.startsWith(deckKey + "/")) {
                delete s.deckPresets[d];
                n++;
              }
            }
            s.deckPresets[deckKey] = presetId;
            await save();
            new Notice(n ? `${n} sub-deck${n === 1 ? "" : "s"} now use this preset.` : "All sub-decks already use this preset.");
            this.render();
          }),
        )
        .addButton((b) =>
          b.setButtonText("Add preset").onClick(async () => {
            const id = newPresetId(s.presets);
            s.presets[id] = { ...structuredClone(p), id, name: `${p.name} copy` };
            s.deckPresets[deckKey] = id;
            await save();
            this.render();
          }),
        );
      if (presetId !== DEFAULT_PRESET_ID) {
        new Setting(contentEl)
          .setName("Preset name")
          .addText((t) =>
            t.setValue(p.name).onChange((v) => {
              p.name = v.trim() || p.name;
              this.plugin.saveSettingsSoon();
            }),
          )
          .addButton((b) =>
            destructive(b)
              .setButtonText("Delete preset")
              .onClick(async () => {
                delete s.presets[presetId];
                for (const d of Object.keys(s.deckPresets)) if (s.deckPresets[d] === presetId) delete s.deckPresets[d];
                await save();
                this.render();
              }),
          );
      }
    }

    const num = (name: string, desc: string, get: () => number, set: (v: number) => void, valid: (v: number) => boolean) =>
      new Setting(contentEl)
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
    const steps = (name: string, desc: string, get: () => string[], set: (v: string[]) => void) =>
      new Setting(contentEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(get().join(" ")).onChange(async (v) => {
            const parsed = parseSteps(v);
            if (!parsed) return;
            set(parsed);
            this.plugin.saveSettingsSoon();
          }),
        );
    const int = (v: number) => Number.isInteger(v) && v >= 0;

    const toggle = (name: string, desc: string, get: () => boolean, set: (v: boolean) => void) =>
      new Setting(contentEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(get()).onChange(async (v) => {
            set(v);
            await save();
          }),
        );
    const choice = <T extends string>(name: string, desc: string, options: Record<T, string>, get: () => T, set: (v: T) => void) =>
      new Setting(contentEl)
        .setName(name)
        .setDesc(desc)
        .addDropdown((d) => {
          for (const [k, label] of Object.entries(options) as Array<[T, string]>) d.addOption(k, label);
          d.setValue(get()).onChange(async (v) => {
            set(v as T);
            await save();
          });
        });

    new Setting(contentEl).setName("Daily limits").setHeading();
    num("New cards/day", "Anki default: 20", () => p.newPerDay, (v) => (p.newPerDay = v), int);
    num("Maximum reviews/day", "Anki default: 200", () => p.reviewsPerDay, (v) => (p.reviewsPerDay = v), int);
    toggle("New cards ignore review limit", "Off (Anki default): new cards stop once the review limit is reached.", () => p.display.newIgnoresReviewLimit, (v) => (p.display.newIgnoresReviewLimit = v));

    new Setting(contentEl).setName("New cards").setHeading();
    steps("Learning steps", "e.g. 1m 10m 1h (units m, h, d). Anki default: 1m 10m", () => p.scheduler.learningSteps, (v) => (p.scheduler.learningSteps = v));
    choice("New card order", "Anki's insertion order.", { notes: "Order in notes (sequential)", random: "Random" }, () => p.display.newOrder, (v) => (p.display.newOrder = v));

    new Setting(contentEl).setName("Lapses").setHeading();
    steps("Relearning steps", "For cards you forgot. Anki default: 10m", () => p.scheduler.relearningSteps, (v) => (p.scheduler.relearningSteps = v));
    num("Leech threshold", "Lapses before a card counts as a leech (and every half of this after). Anki default: 8. 0 = off.", () => p.leechThreshold, (v) => (p.leechThreshold = v), int);
    choice("Leech action", "Anki default: Tag only (here: marked ★).", { tag: "Tag only (mark ★)", suspend: "Suspend card" }, () => p.leechAction, (v) => (p.leechAction = v));

    new Setting(contentEl).setName("Display order").setHeading();
    choice(
      "New/review order",
      "When new cards are shown.",
      { mix: "Mix with reviews", after: "Show after reviews", before: "Show before reviews" },
      () => p.display.newReviewMix,
      (v) => (p.display.newReviewMix = v),
    );
    choice(
      "Review sort order",
      "Anki default: due date, then random.",
      { due: "Due date, then random", ivlAsc: "Ascending intervals", ivlDesc: "Descending intervals", overdue: "Relative overdueness", random: "Random" },
      () => p.display.reviewOrder,
      (v) => (p.display.reviewOrder = v),
    );

    new Setting(contentEl).setName("FSRS").setHeading();
    num(
      "Desired retention",
      "The main dial for review gaps. Lower = longer gaps, fewer reviews (0.85); higher = more reviews (0.95). Anki default: 0.90",
      () => p.scheduler.desiredRetention,
      (v) => (p.scheduler.desiredRetention = v),
      (v) => v >= 0.7 && v <= 0.99,
    );
    new Setting(contentEl)
      .setName("FSRS parameters")
      .setDesc("Optional. Paste the parameters from Anki's deck options (after Optimize) to use them here. Empty = defaults.")
      .addTextArea((t) => {
        t.setValue(p.scheduler.weights.join(", ")).onChange((v) => {
          const nums = v.split(/[\s,]+/).filter(Boolean).map(Number);
          if (v.trim() === "") p.scheduler.weights = [];
          else if (nums.length >= 17 && nums.every(Number.isFinite)) p.scheduler.weights = nums;
          else return;
          this.plugin.saveSettingsSoon();
        });
        t.inputEl.rows = 3;
        t.inputEl.addClass("fc-fsrs-params");
      });
    this.optimizeRow(contentEl, p, presetId);

    new Setting(contentEl).setName("Burying").setHeading();
    toggle("Bury new siblings", "Other new cards from the same card (cloze c2, the reverse) wait until tomorrow.", () => p.bury.newSiblings, (v) => (p.bury.newSiblings = v));
    toggle("Bury review siblings", "Same, for review cards.", () => p.bury.reviewSiblings, (v) => (p.bury.reviewSiblings = v));
    toggle("Bury interday learning siblings", "Same, for cards in learning steps of a day or more.", () => p.bury.learningSiblings, (v) => (p.bury.learningSiblings = v));

    new Setting(contentEl).setName("Timers").setHeading();
    num("Maximum answer seconds", "Answer time is capped at this for statistics. Anki default: 60", () => p.timer.maxAnswerSecs, (v) => (p.timer.maxAnswerSecs = v), (v) => int(v) && v >= 1 && v <= 7200);
    toggle("Show answer timer", "A timer in the top bar while you answer.", () => p.timer.show, (v) => (p.timer.show = v));

    new Setting(contentEl).setName("Auto Advance").setHeading();
    contentEl.createDiv({ cls: "setting-item-description", text: "Start it from the review screen's More menu (⋯ → Auto Advance). 0 = off." });
    num("Seconds to show question for", "", () => p.autoAdvance.questionSecs, (v) => (p.autoAdvance.questionSecs = v), (v) => v >= 0 && v <= 600);
    num("Seconds to show answer for", "", () => p.autoAdvance.answerSecs, (v) => (p.autoAdvance.answerSecs = v), (v) => v >= 0 && v <= 600);
    choice(
      "Answer action",
      "What happens when the answer time runs out.",
      { again: "Answer Again", hard: "Answer Hard", good: "Answer Good", bury: "Bury card" },
      () => p.autoAdvance.answerAction,
      (v) => (p.autoAdvance.answerAction = v),
    );

    new Setting(contentEl).setName("Card back").setHeading();
    new Setting(contentEl)
      .setName("Show figures from the note section")
      .setDesc("If a card's back has no picture, show the pictures under the same heading in its note.")
      .addToggle((t) =>
        t.setValue(p.sectionFigures).onChange(async (v) => {
          p.sectionFigures = v;
          await save();
        }),
      );
    num("Maximum figures", "", () => p.maxFigures, (v) => (p.maxFigures = v), (v) => int(v) && v <= 6);

    new Setting(contentEl).setName("Advanced").setHeading();
    num("Maximum interval (days)", "Anki default: 36500", () => p.scheduler.maximumInterval, (v) => (p.scheduler.maximumInterval = v), (v) => int(v) && v >= 1);
    new Setting(contentEl)
      .setName("Fuzz")
      .setDesc("Spread review dates slightly so cards learned together don't stay together.")
      .addToggle((t) =>
        t.setValue(p.scheduler.fuzz).onChange(async (v) => {
          p.scheduler.fuzz = v;
          await save();
        }),
      );
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Restore Anki defaults").onClick(async () => {
        const d = defaultPreset();
        Object.assign(p, { ...d, id: p.id, name: p.name } satisfies Preset);
        await save();
        this.render();
      }),
    );
  }
}
