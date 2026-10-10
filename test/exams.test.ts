import { describe, expect, it } from "vitest";
import { refsForNote } from "../src/core/collection";
import { isExamMap, missesByNote, parseExamMap, parseItemList, unmappedItems, weakTag, type Exam } from "../src/core/exams";
import { parseNote } from "../src/core/parser";
import { compileSearch } from "../src/core/search";

const NBME: Exam = {
  id: "nbme-13",
  name: "NBME 13",
  source: "nbme",
  blocks: [
    { name: "Section 1", items: { "1": ["Step 2/ID/CMV.md"], "2": ["Step 2/GI/Anorectal.md"], "3": [] } },
    { name: "Section 2", items: { "1": ["Step 2/ID/CMV.md", "Step 2/HIV.md"] } },
  ],
};
const CMS: Exam = { id: "neuro-cms-7", name: "Neuro CMS 7", source: "cms", blocks: [{ name: "Block 1", items: { "4": ["Step 2/ID/CMV.md"] } }] };

describe("exam results (spec 0012)", () => {
  it("parses item lists with ranges, junk and duplicates", () => {
    expect(parseItemList("3, 7,12-14; 7 x 2–1")).toEqual([1, 2, 3, 7, 12, 13, 14]);
    expect(parseItemList("")).toEqual([]);
  });

  it("recognises and parses exam maps, defaulting what's missing", () => {
    expect(isExamMap("Atlas/Step 2 exams.exammap.json")).toBe(true);
    expect(isExamMap("Atlas/links.json")).toBe(false);
    const m = parseExamMap(JSON.stringify({ exams: [{ id: "x", name: "X", blocks: [{ name: "B", items: { "1": ["a.md", 3] } }] }, { name: "no id" }] }));
    expect(m.exams).toEqual([{ id: "x", name: "X", source: "exam", blocks: [{ name: "B", items: { "1": ["a.md"] } }] }]);
    expect(() => parseExamMap("{}")).toThrow();
  });

  it("counts misses per note across forms, newest first, skipping notes that are gone", () => {
    const m = missesByNote(
      [NBME, CMS],
      [
        { examId: "nbme-13", date: "2026-08-19", missed: { "Section 1": [1, 2, 3], "Section 2": [1] } },
        { examId: "neuro-cms-7", date: "2026-08-25", missed: { "Block 1": [4] } },
        { examId: "unknown", date: "2026-08-01", missed: { B: [1] } },
      ],
      (p) => (p.includes("Anorectal") ? null : p),
    );
    expect(m.get("Step 2/ID/CMV.md")).toEqual({
      path: "Step 2/ID/CMV.md",
      count: 3,
      where: ["Neuro CMS 7 · Block 1 #4", "NBME 13 · Section 1 #1", "NBME 13 · Section 2 #1"],
      sources: ["cms", "nbme"],
    });
    expect(m.get("Step 2/HIV.md")?.count).toBe(1);
    expect(m.has("Step 2/GI/Anorectal.md")).toBe(false);
    expect(unmappedItems(NBME, { "Section 1": [2, 3, 9] })).toEqual(["Section 1 #3", "Section 1 #9"]);
    expect(weakTag("Free 120")).toBe("weak-area-free-120");
  });

  it("missed:N finds cards whose own or linked note was missed N+ times", () => {
    const own = refsForNote("Step 2/ID/CMV.md", "ID", parseNote("CMV retinitis: ==ganciclovir==. ^fc-11111111"), 0);
    const anki = refsForNote("Anki/AnKing/ID.md", "AnKing", parseNote("Owl's eye inclusions: ==CMV==. ^fc-aaaaaaaa\n\nHIV is an ==RNA== virus. ^fc-bbbbbbbb"), 1);
    const items = [...own, ...anki].map((ref) => ({ ref }));
    const counts: Record<string, number> = { "Step 2/ID/CMV.md": 3, "Step 2/HIV.md": 1 };
    const linked = (r: (typeof own)[number]) => (r.card.id === "aaaaaaaa" ? ["Step 2/ID/CMV.md"] : r.card.id === "bbbbbbbb" ? ["Step 2/HIV.md"] : []);
    const ctx = { linked, missed: (p: string) => counts[p] ?? 0 };
    const ids = (q: string) => items.filter(compileSearch(q, 0, 4, ctx)).map((i) => i.ref.card.id);
    expect(ids("missed:1")).toEqual(["11111111", "aaaaaaaa", "bbbbbbbb"]);
    expect(ids("missed:2")).toEqual(["11111111", "aaaaaaaa"]);
    expect(ids("-missed:1")).toEqual([]);
    expect(items.filter(compileSearch("missed:1", 0, 4))).toHaveLength(0);
  });
});
