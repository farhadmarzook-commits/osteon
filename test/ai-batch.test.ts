import { describe, expect, it } from "vitest";
import { linesFromBatch, planBatch } from "../src/core/ai-batch";
import { formatAiCard, formatAiTerm, parseAiGlossary } from "../src/core/terms";

describe("AI batch mode (big first runs)", () => {
  const cards = Array.from({ length: 23 }, (_, i) => ({ hash: `h${i}`, text: `Card ${i} mentions the AIN.` }));

  it("groups cards into requests with the live-run card markup", () => {
    const plan = planBatch(cards, 10);
    expect(plan.requests.map((r) => r.customId)).toEqual(["r0", "r1", "r2"]);
    expect(plan.cards.r2).toEqual(["h20", "h21", "h22"]);
    expect(plan.requests[0].user).toContain('<card id="h0">\nCard 0 mentions the AIN.\n</card>');
  });

  it("turns results into glossary lines; failed requests leave their cards for later", () => {
    const plan = planBatch(cards, 10);
    const ok = JSON.stringify({ cards: [{ id: "h0", terms: [{ term: "AIN", definition: "Anterior interosseous nerve." }, { term: " ", definition: "x" }] }] });
    const out = linesFromBatch(
      [{ customId: "r0", json: ok }, { customId: "r1" }, { customId: "r2", json: "not json" }, { customId: "zz", json: ok }],
      plan.cards,
      "claude-haiku-4-5",
      "2026-09-30",
    );
    expect(out.terms).toBe(1);
    expect(out.cardsDone).toBe(10);
    expect(out.failedRequests).toBe(2);
    expect(out.lines[0]).toBe(formatAiTerm("AIN", "Anterior interosseous nerve.", "claude-haiku-4-5", "2026-09-30"));
    expect(out.lines).toContain(formatAiCard("h9"));
    expect(out.lines).not.toContain(formatAiCard("h10"));
    // The written lines read back as looked-at cards, so they're never sent twice.
    const g = parseAiGlossary([out.lines.join("\n")]);
    expect(g.cards.has("h3")).toBe(true);
    expect(g.cards.has("h15")).toBe(false);
  });
});
