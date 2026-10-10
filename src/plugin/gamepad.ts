/**
 * Game controller support (spec 0010): polls connected controllers while Obsidian is in front and
 * runs the bound action in the reviewer or the deck list, through the same code as the keyboard.
 */
import { Notice } from "obsidian";
import { newlyPressed, pressedButtons, resolveAction, type PadAction } from "../core/gamepad";
import type FlashcardsPlugin from "../main";
import type { ActionName } from "./settings";
import { VIEW_DECKS } from "./views/decks";
import { VIEW_REVIEW } from "./views/review";

/** A KeyboardEvent for a key string from the settings ("Space", "Mod+z", "@", "3"). */
function eventFor(key: string): KeyboardEvent {
  const parts = key.split("+");
  const k = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return new KeyboardEvent("keydown", {
    key: k === "Space" ? " " : k,
    metaKey: mods.has("mod"),
    ctrlKey: false,
    altKey: mods.has("alt"),
    shiftKey: mods.has("shift"),
  });
}

interface ReviewLike {
  phase: string;
  onKey(e: KeyboardEvent): boolean;
  contentEl: HTMLElement;
}

export class GamepadService {
  private before = new Map<number, Set<number>>();
  private frame = 0;
  private running = false;

  constructor(private plugin: FlashcardsPlugin) {}

  start(): void {
    const p = this.plugin;
    p.registerDomEvent(window, "gamepadconnected", (e) => {
      if (!p.settings.gamepad.enabled) return;
      new Notice(`Controller connected: ${(e).gamepad.id.replace(/\s*\(.*$/, "")}`);
      this.loop();
    });
    p.registerDomEvent(window, "gamepaddisconnected", () => {
      if (!navigator.getGamepads().some(Boolean)) this.stop();
    });
    p.register(() => this.stop());
    if (navigator.getGamepads?.().some(Boolean)) this.loop();
  }

  private stop(): void {
    this.running = false;
    window.cancelAnimationFrame(this.frame);
  }

  private loop(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.poll();
      this.frame = window.requestAnimationFrame(tick);
    };
    this.frame = window.requestAnimationFrame(tick);
  }

  private poll(): void {
    if (!this.plugin.settings.gamepad.enabled) return;
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      const now = pressedButtons(pad.buttons, pad.axes);
      const pressed = newlyPressed(now, this.before.get(pad.index) ?? new Set());
      this.before.set(pad.index, now);
      for (const b of pressed) this.press(b);
    }
  }

  /** Buttons pressed while the settings' "Press a button" tester is open go there instead. */
  listener: ((button: number) => void | Promise<void>) | null = null;

  private press(button: number): void {
    if (this.listener) return void this.listener(button);
    if (document.querySelector(".modal-container")) return; // don't act behind a dialog
    const { workspace } = this.plugin.app;
    const leaf = workspace.getMostRecentLeaf();
    const type = leaf?.view.getViewType();
    const b = this.plugin.settings.gamepad.bindings;
    if (type === VIEW_REVIEW) {
      const view = leaf!.view as unknown as ReviewLike;
      const where = view.phase === "back" ? "answer" : view.phase === "front" ? "question" : "decks";
      this.runReview(view, where === "decks" ? resolveAction(b, button, "decks") : resolveAction(b, button, where));
    } else if (type === VIEW_DECKS) {
      this.runDecks(resolveAction(b, button, "decks"));
    }
  }

  private key(view: ReviewLike, action: ActionName): void {
    const k = this.plugin.settings.keys[action]?.[0];
    if (k) view.onKey(eventFor(k));
  }

  private runReview(view: ReviewLike, a: PadAction): void {
    if (!a) return;
    const card = view.contentEl.querySelector<HTMLElement>(".fc-card");
    if (a === "scrollUp" || a === "scrollDown") {
      card?.scrollBy({ top: (a === "scrollUp" ? -1 : 1) * card.clientHeight * 0.4, behavior: "smooth" });
      return;
    }
    if (a === "study") return this.key(view, "showAnswer"); // on the overview: Study Now
    if (a === "stats") return void this.plugin.openStats(null);
    this.key(view, a);
  }

  private runDecks(a: PadAction): void {
    if (a === "study") void this.plugin.openReview(null);
    else if (a === "browse") void this.plugin.openBrowse();
    else if (a === "stats") void this.plugin.openStats(null);
  }
}
