/**
 * The add-on API (spec 0005 §1). Other plugins get it with
 *   app.plugins.getPlugin("osteon")?.api
 * Add-ons can decorate cards, react to review events, query cards, and change schedules only
 * through actions, which append proper log events. They never write logs or IDs directly.
 */
import { Events, type EventRef } from "obsidian";
import type { CardRef } from "../core/collection";
import type { QueueItem } from "../core/queue";
import { compileSearch } from "../core/search";
import type { CardState, ReviewEntry } from "../core/state";
import type FlashcardsPlugin from "../main";
import { openApkgImport } from "./anki-import";

export interface ReviewContext {
  ref: CardRef;
  state?: CardState;
  side: "front" | "back";
  /** The rendered card element; decorators may modify its contents. */
  el: HTMLElement;
}

export type ReviewDecorator = (ctx: ReviewContext) => void;

export type ReviewEventName = "cardShown" | "answerShown" | "answer" | "sessionEnd";

export class FlashcardsApi {
  readonly version = "1.0";
  private decorators: ReviewDecorator[] = [];
  private events = new Events();

  constructor(private plugin: FlashcardsPlugin) {}

  /** Run after a card side is rendered. Returns a function that unregisters it. */
  registerReviewDecorator(fn: ReviewDecorator): () => void {
    this.decorators.push(fn);
    return () => {
      this.decorators = this.decorators.filter((d) => d !== fn);
    };
  }

  /** "cardShown"(ctx), "answerShown"(ctx), "answer"(ref, rating), "sessionEnd"(deck). */
  on(name: ReviewEventName, cb: (...args: unknown[]) => void): EventRef {
    return this.events.on(name, cb);
  }

  offref(ref: EventRef): void {
    this.events.offref(ref);
  }

  /** Cards matching Anki-style search, e.g. "deck:Ortho is:due". */
  cards(search = ""): QueueItem[] {
    const match = compileSearch(search, Date.now(), this.plugin.settings.dayStartHour, this.plugin.searchCtx);
    return this.plugin.items(null).filter(match);
  }

  /** Open the .apkg import preview for file bytes (nothing is written until Import). */
  importApkg(fileName: string, bytes: Uint8Array): Promise<void> {
    return openApkgImport(this.plugin, fileName, bytes);
  }

  cardState(key: string): CardState | undefined {
    return this.plugin.state.get(key);
  }

  history(key: string): ReviewEntry[] {
    return [...(this.plugin.state.get(key)?.reviews ?? [])];
  }

  suspend(key: string): Promise<void> {
    return this.act({ type: "suspend", key });
  }

  unsuspend(key: string): Promise<void> {
    return this.act({ type: "unsuspend", key });
  }

  bury(key: string): Promise<void> {
    return this.act({ type: "bury", key });
  }

  reset(key: string): Promise<void> {
    return this.act({ type: "reset", key });
  }

  flag(key: string, flag: number): Promise<void> {
    if (!Number.isInteger(flag) || flag < 0 || flag > 7) return Promise.reject(new Error("flag must be 0–7"));
    return this.act({ type: "flag", key, flag });
  }

  setDue(key: string, due: Date): Promise<void> {
    if (!(due instanceof Date) || Number.isNaN(due.getTime())) return Promise.reject(new Error("setDue needs a valid Date"));
    return this.act({ type: "reschedule", key, due: due.toISOString() });
  }

  // ---- internal ----------------------------------------------------------------------------

  private act(e: { type: "suspend" | "unsuspend" | "bury" | "reset"; key: string } | { type: "flag"; key: string; flag: number } | { type: "reschedule"; key: string; due: string }): Promise<void> {
    if (!/^[a-z0-9]{8}\.[a-z0-9]+$/.test(e.key)) return Promise.reject(new Error(`Not a card key: ${e.key}`));
    return this.plugin.logEvent({ ...e, ts: new Date().toISOString() });
  }

  decorate(ctx: ReviewContext): void {
    for (const d of this.decorators) {
      try {
        d(ctx);
      } catch (err) {
        console.error("Flashcards: a review decorator failed", err);
      }
    }
  }

  emit(name: ReviewEventName, ...args: unknown[]): void {
    this.events.trigger(name, ...args);
  }
}
