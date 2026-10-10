import { describe, expect, it } from "vitest";
import { hiddenFrom, inHiddenDeck } from "../src/core/collection";
import { CardIndex } from "../src/plugin/indexer";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/plugin/settings";
import { App } from "./mocks/obsidian";

describe("hidden decks", () => {
  const hidden = ["step2", "AnKing Step 2"];

  it("Study all skips cards in hidden decks and their sub-decks", () => {
    expect(hiddenFrom("step2/cms/cardiology", null, hidden)).toBe(true);
    expect(hiddenFrom("anking step 2", null, hidden)).toBe(true);
    expect(hiddenFrom("OrthoKing/4) Pocket_Pimped", null, hidden)).toBe(false);
  });

  it("matches whole deck names only", () => {
    expect(hiddenFrom("step2x", null, hidden)).toBe(false);
  });

  it("a visible parent skips its hidden sub-deck", () => {
    expect(hiddenFrom("ortho/old", "ortho", ["ortho/old"])).toBe(true);
    expect(hiddenFrom("ortho/new", "ortho", ["ortho/old"])).toBe(false);
  });

  it("opening a hidden deck (or a deck inside it) still studies it", () => {
    expect(hiddenFrom("step2/cms/gi", "step2", hidden)).toBe(false);
    expect(hiddenFrom("step2/cms/gi", "step2/cms", hidden)).toBe(false);
  });

  it("settings keep a valid list and default to none", () => {
    expect(mergeSettings(null).hiddenDecks).toEqual([]);
    expect(mergeSettings({ hiddenDecks: ["step2", 3] }).hiddenDecks).toEqual(["step2"]);
  });

  it("inHiddenDeck matches a hidden deck and its sub-decks only", () => {
    expect(inHiddenDeck("step2/cms", hidden)).toBe(true);
    expect(inHiddenDeck("step2x", hidden)).toBe(false);
    expect(inHiddenDeck("orthoking", hidden)).toBe(false);
  });
});

describe("the card index skips hidden decks", () => {
  function vault() {
    const app = new App();
    app.vault.files.set("A/Step.md", "#flashcards/step2/cms\n\nThe ==aorta== is here.");
    app.vault.files.set("B/Ortho.md", "#flashcards/ortho\n\nThe ==median nerve== is here.");
    app.vault.files.set("C/Old.md", "#flashcards/old\n\nThe ==ulnar nerve== is here.");
    const reads: string[] = [];
    const read = app.vault.cachedRead.bind(app.vault);
    app.vault.cachedRead = async (f) => (reads.push(f.path), read(f));
    return { app, reads };
  }
  const settings = { ...DEFAULT_SETTINGS, hiddenDecks: ["step2"], deckRenames: [{ from: "old", to: "step2/old" }] };
  const decks = (i: CardIndex) => [...new Set(i.refs().map((r) => r.deck))].sort();

  it("does not read notes in a hidden deck (renames applied first)", async () => {
    const { app, reads } = vault();
    const index = new CardIndex(app as never, () => settings);
    await index.build();
    expect(decks(index)).toEqual(["ortho"]);
    expect(reads).toEqual(["B/Ortho.md"]);
  });

  it("loads them when asked (Show Hidden Decks, imports) and drops them again", async () => {
    const { app } = vault();
    const index = new CardIndex(app as never, () => settings);
    await index.build();
    await index.setWithHidden(true);
    expect(decks(index)).toEqual(["ortho", "step2/cms", "step2/old"]);
    await index.setWithHidden(false);
    expect(decks(index)).toEqual(["ortho"]);
  });

  it("an edit to a hidden note does not bring its cards in", async () => {
    const { app } = vault();
    const index = new CardIndex(app as never, () => settings);
    await index.build();
    const file = app.vault.getMarkdownFiles().find((f) => f.path === "A/Step.md")!;
    index.updateFromText(file as never, "#flashcards/step2/cms\n\nThe ==vena cava== is here.");
    expect(decks(index)).toEqual(["ortho"]);
  });
});

describe("rescanIfChanged", () => {
  it("skips the rebuild when the card notes are the same, and rebuilds when one appears", async () => {
    const app = new App();
    app.vault.files.set("B/Ortho.md", "#flashcards/ortho\n\nThe ==median nerve== is here.");
    const index = new CardIndex(app as never, () => DEFAULT_SETTINGS);
    await index.build();
    let builds = 0;
    index.on("changed", () => builds++);
    expect(await index.rescanIfChanged()).toBe(false);
    expect(builds).toBe(0);
    app.vault.files.set("C/New.md", "#flashcards/ortho\n\nThe ==ulnar nerve== is here.");
    expect(await index.rescanIfChanged()).toBe(true);
    expect(index.refs()).toHaveLength(2);
  });
});
