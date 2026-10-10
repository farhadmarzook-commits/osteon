/**
 * Deck option presets (spec 0003 §4): one preset can be shared by many decks; a sub-deck uses
 * its nearest ancestor's preset unless it has its own.
 */
import { DEFAULT_SCHEDULER, type SchedulerOptions } from "./scheduler";

export interface Preset {
  id: string;
  name: string;
  newPerDay: number;
  reviewsPerDay: number;
  scheduler: SchedulerOptions;
  /** Show figures from the card's note section on the back (spec 0002 §5). */
  sectionFigures: boolean;
  maxFigures: number;
  /** Anki's deck options that aren't scheduling (spec 0003 §4, filled in by 0009). */
  display: DisplayOptions;
  leechThreshold: number;
  leechAction: "suspend" | "tag";
  bury: { newSiblings: boolean; reviewSiblings: boolean; learningSiblings: boolean };
  timer: { maxAnswerSecs: number; show: boolean };
  autoAdvance: { questionSecs: number; answerSecs: number; answerAction: "again" | "hard" | "good" | "bury" };
}

export type NewOrder = "notes" | "random";
export type NewReviewMix = "mix" | "after" | "before";
export type ReviewOrder = "due" | "ivlAsc" | "ivlDesc" | "overdue" | "random";

export interface DisplayOptions {
  newOrder: NewOrder;
  newReviewMix: NewReviewMix;
  reviewOrder: ReviewOrder;
  /** Anki's "New cards ignore review limit". */
  newIgnoresReviewLimit: boolean;
}

export const DEFAULT_PRESET_ID = "default";

export function defaultPreset(): Preset {
  return {
    id: DEFAULT_PRESET_ID,
    name: "Default",
    newPerDay: 20,
    reviewsPerDay: 200,
    scheduler: { ...DEFAULT_SCHEDULER, learningSteps: [...DEFAULT_SCHEDULER.learningSteps], relearningSteps: [...DEFAULT_SCHEDULER.relearningSteps] },
    sectionFigures: true,
    maxFigures: 2,
    display: { newOrder: "notes", newReviewMix: "mix", reviewOrder: "due", newIgnoresReviewLimit: false },
    leechThreshold: 8,
    leechAction: "tag",
    bury: { newSiblings: false, reviewSiblings: false, learningSiblings: false },
    timer: { maxAnswerSecs: 60, show: false },
    autoAdvance: { questionSecs: 0, answerSecs: 0, answerAction: "again" },
  };
}

/** Fill in fields missing from a saved preset (older settings files). */
export function completePreset(p: Partial<Preset> & { id: string }): Preset {
  const d = defaultPreset();
  return {
    ...d,
    ...p,
    scheduler: { ...d.scheduler, ...(p.scheduler ?? {}) },
    display: { ...d.display, ...(p.display ?? {}) },
    bury: { ...d.bury, ...(p.bury ?? {}) },
    timer: { ...d.timer, ...(p.timer ?? {}) },
    autoAdvance: { ...d.autoAdvance, ...(p.autoAdvance ?? {}) },
  };
}

/** The preset for a deck: its own assignment, else its nearest ancestor's, else Default. */
export function presetIdFor(deck: string | null, assignments: Record<string, string>, presets: Record<string, Preset>): string {
  if (deck) {
    const parts = deck.toLowerCase().split("/");
    for (let n = parts.length; n > 0; n--) {
      const id = assignments[parts.slice(0, n).join("/")];
      if (id && presets[id]) return id;
    }
  }
  return DEFAULT_PRESET_ID;
}

export function newPresetId(existing: Record<string, Preset>): string {
  let i = 1;
  while (existing[`p${i}`]) i++;
  return `p${i}`;
}
