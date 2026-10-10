import { describe, expect, it } from "vitest";
import { addRename, cleanDeckName, moveDeckKey, renamedDeck } from "../src/core/collection";

describe("deck rename", () => {
  it("renames a deck and carries its sub-decks", () => {
    const r = [{ from: "Orthopedics/Case Prep", to: "Case Prep" }];
    expect(renamedDeck("Orthopedics/Case Prep", r)).toBe("Case Prep");
    expect(renamedDeck("Orthopedics/Case Prep/ACL Reconstruction", r)).toBe("Case Prep/ACL Reconstruction");
    expect(renamedDeck("orthopedics/case prep/x", r)).toBe("Case Prep/x");
    expect(renamedDeck("Orthopedics/Case Prepx", r)).toBe("Orthopedics/Case Prepx");
    expect(renamedDeck("OrthoKing/4) Pocket_Pimped", r)).toBe("OrthoKing/4) Pocket_Pimped");
  });

  it("renaming again updates the last rule, and renaming back removes it", () => {
    let r = addRename([], "Orthopedics/Case Prep", "Case Prep");
    r = addRename(r, "Case Prep", "Cases");
    expect(r).toEqual([{ from: "Orthopedics/Case Prep", to: "Cases" }]);
    r = addRename(r, "Cases", "Orthopedics/Case Prep");
    expect(r).toEqual([]);
  });

  it("rules chain in order", () => {
    const r = addRename(addRename([], "a/b", "c"), "x", "y");
    expect(renamedDeck("a/b/z", r)).toBe("c/z");
    expect(renamedDeck("x/q", r)).toBe("y/q");
  });

  it("cleans typed names like Anki", () => {
    expect(cleanDeckName(" Ortho :: Case Prep ")).toBe("Ortho/Case Prep");
    expect(cleanDeckName("Case Prep")).toBe("Case Prep");
    expect(cleanDeckName(" / :: ")).toBe("");
  });

  it("moves per-deck settings keys", () => {
    expect(moveDeckKey("orthopedics/case prep", "Orthopedics/Case Prep", "Case Prep")).toBe("case prep");
    expect(moveDeckKey("orthopedics/case prep/acl", "Orthopedics/Case Prep", "Case Prep")).toBe("case prep/acl");
    expect(moveDeckKey("orthoking", "Orthopedics/Case Prep", "Case Prep")).toBe("orthoking");
  });
});
