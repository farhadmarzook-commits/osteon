/** FSRS through ts-fsrs (CLAUDE.md: never write our own scheduler). */
import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  type Card,
  type FSRS,
  type Grade,
  type StepUnit,
} from "ts-fsrs";
import type { RatingName } from "./log";

export interface SchedulerOptions {
  desiredRetention: number;
  maximumInterval: number;
  learningSteps: string[];
  relearningSteps: string[];
  fuzz: boolean;
  /** Custom FSRS parameters; empty means ts-fsrs defaults. */
  weights: number[];
}

export const DEFAULT_SCHEDULER: SchedulerOptions = {
  desiredRetention: 0.9,
  maximumInterval: 36500,
  learningSteps: ["1m", "10m"],
  relearningSteps: ["10m"],
  fuzz: true,
  weights: [],
};

export const GRADE: Record<RatingName, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const STEP = /^\d+(\.\d+)?[mhd]$/;

/** Parse "1m 10m 1h" into steps; returns null if any step is invalid. */
export function parseSteps(input: string): string[] | null {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  return parts.every((p) => STEP.test(p)) ? parts : null;
}

export function makeScheduler(o: SchedulerOptions): FSRS {
  return fsrs(
    generatorParameters({
      request_retention: o.desiredRetention,
      maximum_interval: o.maximumInterval,
      learning_steps: o.learningSteps as StepUnit[],
      relearning_steps: o.relearningSteps as StepUnit[],
      enable_fuzz: o.fuzz,
      enable_short_term: true,
      ...(o.weights.length ? { w: o.weights } : {}),
    }),
  );
}

export function newCard(at: Date): Card {
  return createEmptyCard(at);
}

/** Next due date for each answer button, for showing intervals (spec 0003 §1.3). */
export function previewDue(f: FSRS, card: Card, now: Date): Record<RatingName, Date> {
  return {
    again: f.next(card, now, Rating.Again).card.due,
    hard: f.next(card, now, Rating.Hard).card.due,
    good: f.next(card, now, Rating.Good).card.due,
    easy: f.next(card, now, Rating.Easy).card.due,
  };
}

/** Anki's interval labels: <1m, 10m, 3h, 12d, 3.2mo, 1.5y. */
export function formatInterval(ms: number): string {
  const min = ms / 60000;
  if (min < 1) return "<1m";
  if (min < 60) return `${Math.round(min)}m`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (d < 365) return `${trim(d / 30)}mo`;
  return `${trim(d / 365)}y`;
}
