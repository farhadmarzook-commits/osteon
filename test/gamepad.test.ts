import { describe, expect, it } from "vitest";
import { DEFAULT_PAD_BINDINGS, fromContanki, newlyPressed, pressedButtons, resolveAction } from "../src/core/gamepad";

describe("game controller (spec 0010)", () => {
  const b = DEFAULT_PAD_BINDINGS;
  it("maps his 8BitDo Micro profile: A flips, then answers Good; 1-4 rate; D-pad undo / reveal next", () => {
    expect(resolveAction(b, 0, "question")).toBe("showAnswer");
    expect(resolveAction(b, 0, "answer")).toBe("good");
    expect(resolveAction(b, 1, "answer")).toBe("again");
    expect(resolveAction(b, 2, "answer")).toBe("hard");
    expect(resolveAction(b, 3, "answer")).toBe("easy");
    expect(resolveAction(b, 100, "answer")).toBe("undo");
    expect(resolveAction(b, 101, "answer")).toBe("revealNext");
    expect(resolveAction(b, 8, "answer")).toBe("revealAll");
    expect(resolveAction(b, 11, "question")).toBe("cardInfo");
    expect(resolveAction(b, 0, "decks")).toBe("study");
  });
  it("scrolls with up/down on both sides (never buries by accident)", () => {
    expect(resolveAction(b, 102, "question")).toBe("scrollUp");
    expect(resolveAction(b, 103, "answer")).toBe("scrollDown");
  });
  it("turns stick/D-pad axes into virtual buttons and only fires on press", () => {
    const now = pressedButtons([{ pressed: true }, { pressed: false }], [-1, 0.9]);
    expect([...now].sort((x, y) => x - y)).toEqual([0, 100, 103]);
    expect(newlyPressed(now, new Set([0]))).toEqual([100, 103]);
  });
  it("imports a Contanki profile, dropping actions it doesn't have", () => {
    const p = fromContanki({ answer: { "5": "Good", "7": "Sync" }, overview: { "2": "Open Browser" } });
    expect(p.answer).toEqual({ "5": "good" });
    expect(p.decks).toEqual({ "2": "browse" });
  });
});
