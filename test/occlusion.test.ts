import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cardFaces } from "../src/core/faces";
import { insertCardId } from "../src/core/ids";
import { masksForSlot, newMaskId, occlusionSlots, parseOcclusion, serializeOcclusion } from "../src/core/occlusion";
import { parseNote } from "../src/core/parser";

const text = readFileSync(join(__dirname, "fixtures/vault/Ortho/Knee/Radiograph.md"), "utf8");

describe("occlusion block format", () => {
  const src = text.split("```fc-occlusion\n")[1].split("\n```")[0];
  const occ = parseOcclusion(src);

  it("parses image, mode, header, shapes, labels and groups", () => {
    expect(occ.image).toBe("knee-lateral-radiograph.png");
    expect(occ.mode).toBe("hide-all");
    expect(occ.header).toBe("Lateral knee radiograph, name the structure");
    expect(occ.masks.map((m) => m.shape)).toEqual(["rect", "rect", "ellipse", "poly", "rect", "rect"]);
    expect(occ.masks[3].coords).toHaveLength(8);
    expect(occ.masks[3].label).toBe("Blumensaat's line");
    expect(occ.groups).toEqual([{ id: "b8zn", members: ["r5tw", "w1ky"] }]);
  });

  it("serialises byte-for-byte back to the same text", () => {
    expect(serializeOcclusion(occ)).toBe(src);
    expect(parseOcclusion(serializeOcclusion(occ))).toEqual(occ);
  });

  it("makes one card per ungrouped mask and one per group", () => {
    expect(occlusionSlots(occ)).toEqual(["k7fq", "2mxa", "9c0d", "p4e1", "b8zn"]);
    expect(masksForSlot(occ, "b8zn")).toEqual(["r5tw", "w1ky"]);
    expect(masksForSlot(occ, "k7fq")).toEqual(["k7fq"]);
  });

  it("new mask IDs never reuse a live or retired ID", () => {
    let calls = 0;
    const seq = ["k7fq", "dead", "zzzz"];
    const id = newMaskId(occ, ["dead"], () => {
      const s = seq[Math.floor(calls / 4)];
      const ch = s[calls % 4];
      calls++;
      return "0123456789abcdefghijklmnopqrstuvwxyz".indexOf(ch) / 36 + 0.001;
    });
    expect(id).toBe("zzzz");
  });

  it("ignores malformed rows and out-of-range coordinates", () => {
    const o = parseOcclusion("image: [[x.png]]\nabcd rect 0.1 0.2 5 0.1\nzz rect 0.1 0.1 0.1 0.1\nefgh poly 0.1,0.1 0.2,0.2");
    expect(o.masks).toHaveLength(0);
  });
});

describe("occlusion cards in notes", () => {
  const cards = parseNote(text);

  it("parses the block as a card, with the lines under it as the back", () => {
    expect(cards.map((c) => c.type)).toEqual(["occlusion", "cloze"]);
    const c = cards[0];
    expect(c.slots).toHaveLength(5);
    expect(c.back).toBe("Insall–Salvati ratio = patellar tendon length ÷ patellar length (normal 0.8–1.2).");
    expect(c.headings).toEqual(["Knee radiograph"]);
    const f = cardFaces(c, "p4e1");
    expect(f.kind).toBe("occlusion");
    expect(f.answer).toContain("Blumensaat's line");
  });

  it("writes the ID inside the block, and re-parses with the same slots", () => {
    const out = insertCardId(text, cards[0], "k3x9m2qa")!;
    expect(out).toContain('group b8zn = r5tw w1ky\nid: fc-k3x9m2qa\n```');
    const again = parseNote(out)[0];
    expect(again.id).toBe("k3x9m2qa");
    expect(again.slots).toEqual(cards[0].slots);
    expect(parseNote(out)[1].front).toBe(cards[1].front);
  });
});
