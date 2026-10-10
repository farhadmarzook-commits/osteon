/**
 * Game controller support (spec 0010), after Anki's Contanki add-on: controller buttons map to
 * review actions, with separate bindings for the question side, the answer side, the rest of
 * the review screen, and everywhere. Button numbers are the browser Gamepad API's (the same ones
 * Contanki uses); the D-pad/stick directions become virtual buttons 100–103.
 */

/** What a button can do. Mostly the reviewer's own key actions, plus scrolling. */
export type PadAction =
  | "showAnswer"
  | "again"
  | "hard"
  | "good"
  | "easy"
  | "undo"
  | "suspend"
  | "bury"
  | "mark"
  | "flag1"
  | "cardInfo"
  | "revealNext"
  | "revealAll"
  | "openNote"
  | "editCard"
  | "decks"
  | "browse"
  | "stats"
  | "study"
  | "scrollUp"
  | "scrollDown"
  | "";

export const PAD_ACTIONS: Record<Exclude<PadAction, "">, string> = {
  showAnswer: "Show answer",
  again: "Again",
  hard: "Hard",
  good: "Good",
  easy: "Easy",
  undo: "Undo",
  suspend: "Suspend card",
  bury: "Bury card",
  mark: "Mark",
  flag1: "Red flag",
  cardInfo: "Card info",
  revealNext: "Reveal next answer",
  revealAll: "Reveal all answers",
  openNote: "Open note",
  editCard: "Edit card",
  decks: "Go to decks",
  browse: "Browse",
  stats: "Statistics",
  study: "Study (start / Study all)",
  scrollUp: "Scroll up",
  scrollDown: "Scroll down",
};

export type PadContext = "question" | "answer" | "review" | "decks" | "all";

/** Button number (as a string, like Contanki) → action, per context. */
export type PadBindings = Record<PadContext, Record<string, PadAction>>;

export const AXIS_BUTTONS = { left: 100, right: 101, up: 102, down: 103 } as const;

/** Which action a button does now. Most specific context wins: side → review → decks/all. */
export function resolveAction(b: PadBindings, button: number, where: "question" | "answer" | "decks"): PadAction {
  const k = String(button);
  const order: PadContext[] = where === "decks" ? ["decks", "all"] : [where, "review", "all"];
  for (const c of order) {
    const a = b[c]?.[k];
    if (a) return a;
  }
  return "";
}

/** The pressed buttons, including the D-pad/stick directions as virtual buttons 100–103. */
export function pressedButtons(buttons: ReadonlyArray<{ pressed: boolean; value?: number }>, axes: ReadonlyArray<number>, deadzone = 0.5): Set<number> {
  const out = new Set<number>();
  buttons.forEach((b, i) => {
    if (b.pressed || (b.value ?? 0) > 0.5) out.add(i);
  });
  const x = axes[0] ?? 0;
  const y = axes[1] ?? 0;
  if (x < -deadzone) out.add(AXIS_BUTTONS.left);
  if (x > deadzone) out.add(AXIS_BUTTONS.right);
  if (y < -deadzone) out.add(AXIS_BUTTONS.up);
  if (y > deadzone) out.add(AXIS_BUTTONS.down);
  return out;
}

/** Buttons that went down since the last poll (so holding a button acts once). */
export function newlyPressed(now: Set<number>, before: Set<number>): number[] {
  return [...now].filter((b) => !before.has(b)).sort((a, b) => a - b);
}

/** Contanki's action names → ours (for importing an Anki Contanki profile). */
const CONTANKI: Record<string, PadAction> = {
  "Flip Card": "showAnswer",
  Again: "again",
  Hard: "hard",
  Good: "good",
  Easy: "easy",
  Undo: "undo",
  "Suspend Card": "suspend",
  "Suspend Note": "suspend",
  "Bury Card": "bury",
  "Bury Note": "bury",
  "Mark Note": "mark",
  Flag: "flag1",
  "Card Info": "cardInfo",
  "reveal next": "revealNext",
  "reveal all": "revealAll",
  "Scroll Up": "scrollUp",
  "Scroll Up Smooth": "scrollUp",
  "Scroll Down": "scrollDown",
  "Scroll Down Smooth": "scrollDown",
  "Go to Main Screen": "decks",
  "Open Browser": "browse",
  "Open Statistics": "stats",
  Select: "study",
};

/**
 * Convert a Contanki profile's `bindings`. Its "Enter" means Show answer on the question and Good
 * on the answer (Anki's Enter); actions we don't have (Sync, Redo, Replay Audio…) are dropped.
 */
export function fromContanki(bindings: Record<string, Record<string, string>>): PadBindings {
  const out: PadBindings = { question: {}, answer: {}, review: {}, decks: {}, all: {} };
  const put = (ctx: PadContext, button: string, name: string) => {
    let a: PadAction | undefined;
    if (name === "Enter") a = ctx === "answer" ? "good" : ctx === "decks" ? "study" : "showAnswer";
    else a = CONTANKI[name];
    if (a) out[ctx][button] = a;
  };
  for (const [ctx, map] of Object.entries(bindings)) {
    const target: PadContext | null =
      ctx === "question" || ctx === "answer" || ctx === "review" || ctx === "all" ? ctx : ctx === "deckBrowser" || ctx === "overview" ? "decks" : null;
    if (!target) continue;
    for (const [button, name] of Object.entries(map)) if (name) put(target, button, name);
  }
  // An "all" Enter should still mean Good on the answer side.
  for (const [button, a] of Object.entries(out.all)) if (a === "showAnswer" && !out.answer[button]) out.answer[button] = "good";
  return out;
}

/** His 8BitDo Micro profile from Contanki (Anki), converted: the default bindings. */
export const DEFAULT_PAD_BINDINGS: PadBindings = fromContanki({
  all: { "0": "Enter", "1": "Enter", "9": "Go to Main Screen", "100": "Undo", "8": "reveal all", "102": "Scroll Up", "103": "Scroll Down" },
  review: { "14": "Flag", "15": "Mark Note", "11": "Card Info", "102": "Bury Note" },
  // Up/down scroll on the question too (his profile left them blank, which fell through to Bury).
  question: { "0": "Flip Card", "1": "Flip Card", "6": "Suspend Card", "102": "Scroll Up", "103": "Scroll Down" },
  answer: { "1": "Again", "2": "Hard", "3": "Easy", "4": "Hard", "6": "Suspend Card", "8": "reveal all", "101": "reveal next", "102": "Scroll Up Smooth", "103": "Scroll Down Smooth", "9": "Go to Main Screen" },
  deckBrowser: { "0": "Select", "1": "Select", "2": "Open Browser", "3": "Open Statistics" },
});
