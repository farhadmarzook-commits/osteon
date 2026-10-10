import { describe, expect, it } from "vitest";
import { refsForNote } from "../src/core/collection";
import type { LogEvent } from "../src/core/log";
import { parseNote } from "../src/core/parser";
import type { QueueItem } from "../src/core/queue";
import { DEFAULT_SCHEDULER, makeScheduler } from "../src/core/scheduler";
import { replay } from "../src/core/state";
import { topicOf, topicStats, weakCards } from "../src/core/weak";

const f = makeScheduler({ ...DEFAULT_SCHEDULER, fuzz: false });
const NOTE = [
  "The {{c1::Velpeau}} view is used when an axillary is not tolerated.\n**Orthobullets:** [Orthobullets](https://www.orthobullets.com/shoulder-and-elbow/3051/posterior-shoulder-instability) ^fc-aaaaaaaa",
  "The {{c1::Zanca}} view shows the AC joint.\n**Orthobullets:** [Orthobullets](https://www.orthobullets.com/shoulder-and-elbow/3038/shoulder-imaging) ^fc-bbbbbbbb",
  "A {{c1::scaphoid}} fracture risks AVN.\n**Orthobullets:** [Orthobullets](https://www.orthobullets.com/hand/6034/scaphoid-fracture) ^fc-cccccccc",
  "Plain card with {{c1::no link}}. ^fc-dddddddd",
].join("\n\n");

function items(events: LogEvent[]): QueueItem[] {
  const refs = refsForNote("Anki/PP.md", "OrthoKing/4) Pocket_Pimped", parseNote(NOTE), 0);
  const states = replay(events, { schedulerFor: () => f, dayStartHour: 4 });
  return refs.map((ref) => ({ ref, state: ref.key ? states.get(ref.key) : undefined }));
}
const rev = (min: number, id: string, rating: "again" | "good"): LogEvent => ({ ts: `2026-10-04T12:${String(min).padStart(2, "0")}:00.000Z`, type: "review", key: `${id}.c1`, rating, ms: 3000, hash: "0", device: "iphone" });
const since = Date.parse("2026-10-04T08:00:00.000Z");

describe("weak spots (0.21.0)", () => {
  const events = [
    rev(1, "aaaaaaaa", "again"), rev(2, "aaaaaaaa", "again"), rev(3, "aaaaaaaa", "again"), rev(4, "aaaaaaaa", "good"),
    rev(5, "bbbbbbbb", "again"), rev(6, "bbbbbbbb", "good"),
    rev(7, "cccccccc", "good"), rev(8, "cccccccc", "good"),
    rev(9, "dddddddd", "again"), rev(10, "dddddddd", "again"),
    { ...rev(11, "cccccccc", "again"), ts: "2026-10-01T12:00:00.000Z" },
  ];

  it("names a card's topic from its Orthobullets section, else its deck", () => {
    const all = items([]);
    expect(topicOf(all[0].ref)).toBe("Shoulder & Elbow");
    expect(topicOf(all[2].ref)).toBe("Hand");
    expect(topicOf(all[3].ref)).toBe("Pocket Pimped");
  });

  it("lists the cards missed most in the period, most missed first", () => {
    const weak = weakCards(items(events), since, 2);
    expect(weak.map((w) => [w.item.ref.card.id, w.misses, w.answers])).toEqual([
      ["aaaaaaaa", 3, 4],
      ["dddddddd", 2, 2],
    ]);
  });

  it("ranks topics by miss rate over the period", () => {
    const stats = topicStats(items(events), since, 2);
    expect(stats.map((s) => [s.topic, s.cards, s.answers, s.misses])).toEqual([
      ["Pocket Pimped", 1, 2, 2],
      ["Shoulder & Elbow", 2, 6, 4],
      ["Hand", 1, 2, 0],
    ]);
    expect(stats[1].rate).toBeCloseTo(4 / 6);
  });
});
