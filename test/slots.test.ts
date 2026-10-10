import { describe, expect, it } from "vitest";
import { slotsById, slotsWithHistory } from "../src/core/collection";
import type { CardState } from "../src/core/state";

const st = (reviews: number) => ({ reviews: Array.from({ length: reviews }, () => ({})) }) as unknown as CardState;

describe("slotsById", () => {
  const states = new Map<string, CardState>([
    ["abcd1234.c1", st(2)],
    ["abcd1234.x9f2", st(1)],
    ["abcd1234.c2", st(0)],
    ["zzzz0000.c1", st(3)],
    ["abcd12345.c1", st(1)],
  ]);

  it("matches slotsWithHistory for every card ID, in one pass", () => {
    const by = slotsById(states);
    for (const id of ["abcd1234", "zzzz0000", "abcd12345", "missing0"]) {
      expect(by.get(id) ?? []).toEqual(slotsWithHistory(id, states));
    }
  });

  it("skips slots that were never reviewed", () => {
    expect(slotsById(states).get("abcd1234")).toEqual(["c1", "x9f2"]);
  });
});
