import { describe, expect, it } from "vitest";
import { buildFiltered } from "../src/core/filtered";
import { refsForNote } from "../src/core/collection";
import { isLinkTable, LinkIndex, parseLinkTable, parseManifest } from "../src/core/links";
import { parseNote } from "../src/core/parser";
import { compileSearch } from "../src/core/search";

const MANIFEST = [
  "# Imported Anki notes (GUID → card ID) · do not edit by hand",
  "",
  "g#1\tfc-aaaaaaaa",
  "g2\tfc-bbbbbbbb\t0f2c8a7e-1d2b-4c3d-9e8f-a1b2c3d4e5f6",
  "g3\tfc-cccccccc",
  "",
].join("\n");

describe("linked notes (spec 0011)", () => {
  it("recognises link tables by name and drops malformed rows", () => {
    expect(isLinkTable("Step 2/AnKing.cardlinks.json")).toBe(true);
    expect(isLinkTable("Step 2/AnKing.json")).toBe(false);
    const t = parseLinkTable(JSON.stringify({ version: 1, links: [{ guid: "g", note: "A.md" }, { guid: "", note: "B.md" }, { note: "C.md" }] }));
    expect(t.links).toEqual([{ guid: "g", note: "A.md" }]);
    expect(() => parseLinkTable("{}")).toThrow();
  });

  it("reads the import manifest, GUIDs starting with # included, and the AnkiHub column", () => {
    const m = parseManifest(MANIFEST);
    expect(m.get("aaaaaaaa")).toEqual(["g#1"]);
    expect(m.get("bbbbbbbb")).toEqual(["g2", "0f2c8a7e-1d2b-4c3d-9e8f-a1b2c3d4e5f6"]);
    expect(m.size).toBe(3);
  });

  it("maps cards to notes by GUID or AnkiHub ID, both ways, skipping notes that are gone", () => {
    const table = {
      version: 1,
      links: [
        { guid: "g#1", note: "Cardio/Heart Failure.md" },
        { guid: "other-guid", ankihub_id: "0f2c8a7e-1d2b-4c3d-9e8f-a1b2c3d4e5f6", note: "Cardio/Heart Failure.md" },
        { guid: "g3", note: "Deleted.md" },
      ],
    };
    const idx = new LinkIndex([table], parseManifest(MANIFEST), (n) => (n === "Deleted.md" ? null : n));
    expect(idx.notesFor("aaaaaaaa")).toEqual(["Cardio/Heart Failure.md"]);
    expect(idx.notesFor("bbbbbbbb")).toEqual(["Cardio/Heart Failure.md"]);
    expect(idx.notesFor("cccccccc")).toEqual([]);
    expect(idx.notesFor(undefined)).toEqual([]);
    expect(idx.cardsFor("Cardio/Heart Failure.md")).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    expect(idx.size).toBe(2);
  });

  it("note: finds a note's own cards and the imported cards linked to it", () => {
    const own = refsForNote("Cardio/Heart Failure.md", "Cardio", parseNote("HFrEF EF is ==≤40%==. ^fc-11111111"), 0);
    const anki = refsForNote("Anki/AnKing/Cardio.md", "AnKing", parseNote("Loop diuretics relieve ==congestion==. ^fc-aaaaaaaa\n\nStatins lower ==LDL==. ^fc-cccccccc"), 1);
    const items = [...own, ...anki].map((ref) => ({ ref }));
    const idx = new LinkIndex([{ version: 1, links: [{ guid: "g#1", note: "Cardio/Heart Failure.md" }] }], parseManifest(MANIFEST));
    const linked = (r: (typeof own)[number]) => idx.notesFor(r.card.id);
    const q = 'note:"Cardio/Heart Failure.md"';
    expect(items.filter(compileSearch(q, 0, 4, { linked })).map((i) => i.ref.card.id)).toEqual(["11111111", "aaaaaaaa"]);
    expect(items.filter(compileSearch(q, 0, 4)).map((i) => i.ref.card.id)).toEqual(["11111111"]);
    expect(buildFiltered(items, { search: q, limit: 10, order: "notes" }, 0, 4, { linked })).toHaveLength(2);
  });
});
