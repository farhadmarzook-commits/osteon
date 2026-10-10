import { describe, expect, it } from "vitest";
import { excerptLine, searchNotes, type SearchableNote } from "../src/core/note-search";

const notes: SearchableNote[] = [
  { path: "Trauma/Tibial Plateau Fracture.md", names: ["Tibial Plateau Fracture", "Bumper fracture"], headings: ["Workup", "Fixation"] },
  { path: "Class/Knee and Tibia Classification.md", names: ["Knee and Tibia Classification"], headings: ["Schatzker — tibial plateau", "Tscherne"] },
  { path: "Approaches/Tibia and Fibula Approaches.md", names: ["Tibia and Fibula Approaches"], headings: ["Anterior approach"] },
  { path: "Spine/Cervical Disc Herniation.md", names: ["Cervical Disc Herniation"], headings: [] },
];
const paths = (q: string) => searchNotes(q, notes).map((h) => h.path.split("/").pop());

describe("note picker search", () => {
  it("matches words in any order and by their start", () => {
    expect(paths("plateau tib")[0]).toBe("Tibial Plateau Fracture.md");
    expect(paths("herniat")).toEqual(["Cervical Disc Herniation.md"]);
  });
  it("needs every word", () => {
    expect(paths("tibial herniation")).toEqual([]);
    expect(paths("")).toEqual([]);
  });
  it("finds a note by an alias", () => {
    expect(paths("bumper")).toEqual(["Tibial Plateau Fracture.md"]);
  });
  it("finds a note by a heading and says which", () => {
    const hits = searchNotes("schatzker", notes);
    expect(hits).toEqual([{ path: "Class/Knee and Tibia Classification.md", heading: "Schatzker — tibial plateau" }]);
  });
  it("puts a title match above a heading match", () => {
    expect(paths("plateau")).toEqual(["Tibial Plateau Fracture.md", "Knee and Tibia Classification.md"]);
  });
  it("matches inside a word only from three letters", () => {
    expect(paths("lateau")).toContain("Tibial Plateau Fracture.md");
    expect(paths("ib")).toEqual([]);
  });
});

describe("excerpt line", () => {
  it("skips properties and tags and strips Markdown", () => {
    const ex = "- ortho/tibia<br>cssclasses:<br>  - row-alt<br>---<br>[[Orthopedics MOC]] · [[Trauma Quick Reference]]<br># Tibial Plateau Fracture<br>One page, for **standing** at the table.";
    expect(excerptLine(ex, ["standing"])).toBe("One page, for standing at the table.");
    expect(excerptLine(ex, ["zzz"])).toBe("Orthopedics MOC · Trauma Quick Reference");
  });
  it("turns HTML entities back into characters and drops the quote mark", () => {
    expect(excerptLine("&gt; ACL · PCL &amp; LCL", ["acl"])).toBe("ACL · PCL & LCL");
  });
  it("cuts a long line", () => {
    expect(excerptLine("word ".repeat(80), ["word"], 40).length).toBeLessThanOrEqual(40);
  });
});
