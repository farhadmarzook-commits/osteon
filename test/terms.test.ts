import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDictionary,
  findTerms,
  formatAiCard,
  formatAiTerm,
  meshEntries,
  noteSummary,
  parseAiGlossary,
  parseMeshAscii,
  parseMyTerms,
  stem,
  termTokens,
  type TermEntry,
} from "../src/core/terms";

const mesh = parseMeshAscii(readFileSync(join(__dirname, "fixtures/mesh-sample.bin"), "utf8"));

describe("MeSH parser", () => {
  it("keeps clinical branches only and un-inverts headings", () => {
    expect(mesh.map((r) => r[0])).toEqual(["Median Nerve", "Rheumatoid Arthritis", "Hand", "Scaphoid Bone"]);
    const median = mesh[0];
    expect(median[1]).toContain("Nerve, Median");
    expect(median[1]).toContain("Median Nerves");
    expect(median[2]).toMatch(/^A major nerve of the upper extremity/);
    expect(mesh[1][1]).toContain("Arthritis, Rheumatoid");
  });
});

describe("matching", () => {
  const list: TermEntry = { term: "AIN", variants: ["AIN", "anterior interosseous nerve"], definition: "Median nerve branch.", source: "list" };
  const note: TermEntry = { term: "Galeazzi fracture", variants: ["Galeazzi fracture"], definition: "", source: "note", notePath: "Galeazzi fracture.md" };
  const entries = [note, list, ...meshEntries(mesh)];

  it("stems plurals and possessives", () => {
    expect(stem("fractures")).toBe("fracture");
    expect(stem("arteries")).toBe("artery");
    expect(stem("fibrosis")).toBe("fibrosis");
    expect(termTokens("Galeazzi's fracture-dislocations")).toEqual(["galeazzi", "fracture", "dislocation"]);
  });

  it("finds multi-word terms first, once each, across plurals and case", () => {
    const dict = buildDictionary(entries, { sensitivity: "uncommon", hidden: new Set() });
    const text = "The AIN branches from the median nerve; median nerves and Galeazzi fractures. The AIN again.";
    const found = findTerms(text, dict);
    expect(found.map((m) => text.slice(m.start, m.end))).toEqual(["AIN", "median nerve", "Galeazzi fractures"]);
    expect(found[1].entry.term).toBe("Median Nerve");
  });

  it("skips everyday single words in 'uncommon' mode, keeps them in 'all'", () => {
    const uncommon = buildDictionary(entries, { sensitivity: "uncommon", hidden: new Set() });
    const all = buildDictionary(entries, { sensitivity: "all", hidden: new Set() });
    const text = "Pain in the hand after a scaphoid injury.";
    expect(findTerms(text, uncommon).map((m) => m.entry.term)).toEqual(["Scaphoid Bone"]);
    expect(findTerms(text, all).map((m) => m.entry.term)).toEqual(["Hand", "Scaphoid Bone"]);
  });

  it("earlier sources win, and the hide list is respected", () => {
    const mine: TermEntry = { term: "Scaphoid", variants: ["scaphoid"], definition: "My own definition.", source: "list" };
    const dict = buildDictionary([mine, ...entries], { sensitivity: "all", hidden: new Set(["hand"]) });
    const found = findTerms("scaphoid of the hand", dict);
    expect(found.map((m) => m.entry.definition)).toEqual(["My own definition."]);
  });

  it("off means no underlines", () => {
    expect(buildDictionary(entries, { sensitivity: "off", hidden: new Set() }).size).toBe(0);
  });
});

describe("My terms note", () => {
  it("parses definitions with aliases and the never-underline list", () => {
    const t = parseMyTerms(
      "# My terms\n\n## Define\n- AIN (anterior interosseous nerve, AIN palsy): Median nerve branch.\n- Resident's ridge: Behind it lies the ACL.\n- no colon here\n\n## Never underline\n- Fracture\n- Lateral\n",
    );
    expect(t.defs).toEqual([
      { term: "AIN", aliases: ["anterior interosseous nerve", "AIN palsy"], definition: "Median nerve branch." },
      { term: "Resident's ridge", aliases: [], definition: "Behind it lies the ACL." },
    ]);
    expect(t.hidden).toEqual(["Fracture", "Lateral"]);
  });
});

describe("note summaries", () => {
  it("takes the first paragraph and images, skipping frontmatter and headings", () => {
    const s = noteSummary(
      "---\naliases: [x]\n---\n# Galeazzi fracture\n\n![[galeazzi.png]]\n\nA fracture of the distal third of the [[radius]] with **DRUJ** dislocation.\nNeeds ORIF.\n\nMore text.\n![[second.jpg]]\n![[third.png]]",
    );
    expect(s.definition).toBe("A fracture of the distal third of the radius with DRUJ dislocation. Needs ORIF.");
    expect(s.images).toEqual(["![[galeazzi.png]]", "![[second.jpg]]"]);
  });
});

describe("AI glossary files", () => {
  it("round-trips terms and card markers across devices, first definition wins", () => {
    const a = [formatAiTerm("Terry Thomas sign", "Widened scapholunate gap on AP view.", "claude-opus-5", "2026-09-27"), formatAiCard("ab12")].join("\n");
    const b = [formatAiTerm("terry thomas sign", "Other.", "m", "d"), formatAiCard("cd34")].join("\n");
    const g = parseAiGlossary([a, b]);
    expect(g.terms).toEqual([{ term: "Terry Thomas sign", definition: "Widened scapholunate gap on AP view." }]);
    expect([...g.cards]).toEqual(["ab12", "cd34"]);
  });
});

describe("matcher details", () => {
  const pin: TermEntry = { term: "PIN", variants: ["PIN"], definition: "Posterior interosseous nerve.", source: "list" };
  const aids: TermEntry = { term: "AIDS", variants: ["AIDS"], definition: "x", source: "mesh" };
  const gbs: TermEntry = { term: "Guillain–Barré syndrome", variants: ["Guillain-Barré syndrome"], definition: "x", source: "mesh" };

  it("abbreviations match case-sensitively and aren't stemmed", () => {
    const d = buildDictionary([pin, aids], { sensitivity: "all", hidden: new Set() });
    expect(findTerms("Use a pin. The PIN is at risk.", d).map((m) => m.start)).toEqual([15]);
    expect(findTerms("first aid kit", d)).toHaveLength(0);
    expect(findTerms("patients with AIDS", d)).toHaveLength(1);
  });

  it("matches accented names, with or without the accents", () => {
    const d = buildDictionary([gbs], { sensitivity: "all", hidden: new Set() });
    expect(findTerms("Guillain-Barré syndrome after infection", d)[0].end).toBe("Guillain-Barré syndrome".length);
    expect(findTerms("Guillain Barre syndrome", d)).toHaveLength(1);
  });

  it("layers: longest match wins across layers, earlier layer wins ties", () => {
    const mine: TermEntry = { term: "Median nerve", variants: ["median nerve"], definition: "Mine.", source: "list" };
    const longer: TermEntry = { term: "Median nerve palsy", variants: ["median nerve palsy"], definition: "MeSH.", source: "mesh" };
    const same: TermEntry = { term: "Median Nerve", variants: ["Median Nerve"], definition: "MeSH same.", source: "mesh" };
    const a = buildDictionary([mine], { sensitivity: "all", hidden: new Set() });
    const b = buildDictionary([longer, same], { sensitivity: "all", hidden: new Set() });
    expect(findTerms("a median nerve palsy", [a, b])[0].entry.definition).toBe("MeSH.");
    expect(findTerms("the median nerve", [a, b])[0].entry.definition).toBe("Mine.");
  });
});

describe("hard terms only", () => {
  const mesh = (term: string) => ({ term, variants: [term], definition: "d", source: "mesh" as const });
  it("skips basic and short single words but keeps hard and multi-word terms", () => {
    const d = buildDictionary(["Pelvis", "Sacrum", "X-Ray", "Deformities", "Standardization", "Polytrauma", "Sacroiliac Joint", "Spondylolisthesis", "AIDS"].map(mesh), { sensitivity: "strict", hidden: new Set() });
    const found = findTerms("Pelvis, sacrum and x-ray standardization for deformities; polytrauma, sacroiliac joint, spondylolisthesis, AIDS.", d).map((m) => m.entry.term);
    expect(found).toEqual(["Polytrauma", "Sacroiliac Joint", "Spondylolisthesis", "AIDS"]);
  });
  it("still underlines his own notes' titles", () => {
    const d = buildDictionary([{ term: "Pelvis", variants: ["Pelvis"], definition: "", source: "note" as const, notePath: "P.md" }], { sensitivity: "strict", hidden: new Set() });
    expect(findTerms("the pelvis", d)).toHaveLength(1);
  });
});
