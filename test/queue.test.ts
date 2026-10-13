import { describe, expect, it } from "vitest";
import { deckFor, findClozeAlias, inDeck, refsForNote } from "../src/core/collection";
import type { LogEvent } from "../src/core/log";
import { parseNote } from "../src/core/parser";
import { buildQueue, counts, DEFAULT_QUEUE, nextCard, restrictQueue, type CardKind, type QueueItem } from "../src/core/queue";
import { DEFAULT_SCHEDULER, formatInterval, makeScheduler, parseSteps, previewDue, newCard } from "../src/core/scheduler";
import { replay } from "../src/core/state";

const f = makeScheduler({ ...DEFAULT_SCHEDULER, fuzz: false });
const opts = { schedulerFor: () => f, dayStartHour: 4 };

/** A note with n one-cloze cards, all with IDs c0000000..., so they can have history. */
function note(n: number): string {
  return Array.from({ length: n }, (_, i) => `Fact ${i} is ==answer ${i}==. ^fc-${String(i).padStart(8, "0")}`).join("\n\n");
}

function items(n: number, events: LogEvent[]): QueueItem[] {
  const refs = refsForNote("Deck/N.md", "Deck", parseNote(note(n)), 0);
  const states = replay(events, opts);
  return refs.map((ref) => ({ ref, state: ref.key ? states.get(ref.key) : undefined }));
}

function keyOf(i: number): string {
  const card = parseNote(note(i + 1))[i];
  return `${card.id}.${card.slots[0]}`;
}

const rev = (ts: string, key: string, rating: "again" | "good" = "good"): LogEvent => ({ ts, type: "review", key, rating, ms: 3000, hash: "0000", device: "mac" });

describe("decks", () => {
  it("uses the #flashcards/ sub-tag, else the folder, else Default", () => {
    expect(deckFor("Ortho/Knee/ACL.md", ["flashcards"])).toBe("Ortho/Knee");
    expect(deckFor("Ortho/Knee/ACL.md", ["flashcards/Ortho/Sports"])).toBe("Ortho/Sports");
    expect(deckFor("ACL.md", ["flashcards"])).toBe("Default");
    // Imported Anki decks keep their real names (tags can't hold spaces or punctuation).
    expect(deckFor("Anki/X.md", ["flashcards/OrthoKing/1-Netter-s"], "#OrthoKing::1) Netter's::A/B")).toBe("OrthoKing/1) Netter's/A-B");
    expect(inDeck("Ortho/Knee", "Ortho")).toBe(true);
    expect(inDeck("Orthopaedics", "Ortho")).toBe(false);
    expect(inDeck("ortho/elbow", "Ortho")).toBe(true);
  });
});

describe("buildQueue", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");

  it("limits new cards per day and keeps note order", () => {
    const q = buildQueue(items(30, []), now, DEFAULT_QUEUE);
    expect(q.fresh).toHaveLength(20);
    expect(q.fresh[0].ref.card.front).toContain("Fact 0");
  });

  it("counts new cards studied earlier today against the limit (from all devices)", () => {
    const events = Array.from({ length: 5 }, (_, i) => rev(`2026-09-27T0${5 + (i % 4)}:0${i}:00.000Z`, keyOf(i)));
    const q = buildQueue(items(30, events), now, DEFAULT_QUEUE);
    expect(q.fresh).toHaveLength(15);
  });

  it("puts a card answered Again into learning, due after its 1m step", () => {
    const events = [rev("2026-09-27T11:59:30.000Z", keyOf(0), "again")];
    const q = buildQueue(items(3, events), now, DEFAULT_QUEUE);
    expect(q.learning).toHaveLength(1);
    expect(counts(q)).toEqual({ fresh: 2, learning: 1, review: 0 });
    // Due (1m step elapsed) learning cards come first.
    const later = new Date("2026-09-27T12:01:00.000Z");
    expect(nextCard(q, later, 0)!.ref.key).toBe(keyOf(0));
  });

  it("shows review cards due today and respects the review limit", () => {
    const events = Array.from({ length: 10 }, (_, i) => [
      rev("2026-09-01T10:00:00.000Z", keyOf(i)),
      rev("2026-09-01T10:10:00.000Z", keyOf(i)),
    ]).flat();
    const q = buildQueue(items(10, events), now, { ...DEFAULT_QUEUE, reviewsPerDay: 4 });
    expect(q.review).toHaveLength(4);
    // New cards are also capped by the review limit (Anki v3).
    expect(q.fresh).toHaveLength(0);
  });

  it("skips suspended and buried cards", () => {
    const events: LogEvent[] = [
      { ts: "2026-09-27T10:00:00.000Z", type: "suspend", key: keyOf(0), device: "mac" },
      { ts: "2026-09-27T10:00:00.000Z", type: "bury", key: keyOf(1), device: "mac" },
    ];
    const q = buildQueue(items(3, events), now, DEFAULT_QUEUE);
    expect(q.fresh.map((i) => i.ref.key)).toEqual([keyOf(2)]);
  });
});

describe("scheduler helpers", () => {
  it("formats intervals like Anki", () => {
    expect(formatInterval(30_000)).toBe("<1m");
    expect(formatInterval(10 * 60_000)).toBe("10m");
    expect(formatInterval(3 * 3600_000)).toBe("3h");
    expect(formatInterval(4 * 86400_000)).toBe("4d");
    expect(formatInterval(96 * 86400_000)).toBe("3.2mo");
    expect(formatInterval(365 * 86400_000)).toBe("1y");
  });

  it("previews learning steps for a new card: Again 1m, Good 10m", () => {
    const now = new Date("2026-09-27T12:00:00.000Z");
    const p = previewDue(f, newCard(now), now);
    expect(formatInterval(p.again.getTime() - now.getTime())).toBe("1m");
    expect(formatInterval(p.good.getTime() - now.getTime())).toBe("10m");
  });

  it("validates learning steps", () => {
    expect(parseSteps("1m 10m 1h")).toEqual(["1m", "10m", "1h"]);
    expect(parseSteps("1m ten")).toBeNull();
  });
});

describe("findClozeAlias", () => {
  it("links an edited cloze to its old slot when it's the only change", () => {
    const before = parseNote("The ==ulnr== nerve. ^fc-aaaaaaaa")[0];
    const after = parseNote("The ==ulnar== nerve. ^fc-aaaaaaaa")[0];
    expect(findClozeAlias(after, before.slots)).toEqual({ from: `aaaaaaaa.${before.slots[0]}`, to: `aaaaaaaa.${after.slots[0]}` });
  });

  it("does nothing when the change is ambiguous", () => {
    const before = parseNote("==a== and ==b== ^fc-aaaaaaaa")[0];
    const after = parseNote("==c== and ==d== ^fc-aaaaaaaa")[0];
    expect(findClozeAlias(after, before.slots)).toBeNull();
  });
});

describe("Anki's display order, limits and burying (spec 0009)", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const disp = (d: Partial<NonNullable<typeof DEFAULT_QUEUE.display>>) => ({ ...DEFAULT_QUEUE, display: { newOrder: "notes" as const, newReviewMix: "mix" as const, reviewOrder: "due" as const, newIgnoresReviewLimit: false, ...d } });
  // Cards 0-3 reviewed long ago (due now) with different intervals; the rest new.
  const events = [
    rev("2026-08-01T10:00:00.000Z", keyOf(0)), rev("2026-08-01T10:10:00.000Z", keyOf(0)),
    rev("2026-09-20T10:00:00.000Z", keyOf(1)), rev("2026-09-20T10:10:00.000Z", keyOf(1)),
  ];

  it("new cards: in note order, or random", () => {
    const a = buildQueue(items(12, []), now, disp({})).fresh.map((i) => i.ref.card.front);
    const b = buildQueue(items(12, []), now, disp({ newOrder: "random" })).fresh.map((i) => i.ref.card.front);
    expect(a[0]).toContain("Fact 0");
    expect(b).not.toEqual(a);
    expect([...b].sort()).toEqual([...a].sort());
  });

  it("new/review order: after or before reviews", () => {
    expect(nextCard(buildQueue(items(6, events), now, disp({ newReviewMix: "after" })), now, 5)?.state).toBeDefined();
    expect(nextCard(buildQueue(items(6, events), now, disp({ newReviewMix: "before" })), now, 0)?.state).toBeUndefined();
  });

  it("review order by interval", () => {
    const asc = buildQueue(items(6, events), now, disp({ reviewOrder: "ivlAsc" })).review.map((i) => i.state!.card.scheduled_days);
    const desc = buildQueue(items(6, events), now, disp({ reviewOrder: "ivlDesc" })).review.map((i) => i.state!.card.scheduled_days);
    expect(asc).toEqual([...asc].sort((x, y) => x - y));
    expect(desc).toEqual([...desc].sort((x, y) => y - x));
  });

  it("new cards can ignore the review limit", () => {
    const o = { ...disp({}), reviewsPerDay: 1 };
    expect(buildQueue(items(10, events), now, o).fresh.length).toBe(0);
    expect(buildQueue(items(10, events), now, { ...o, display: { ...o.display, newIgnoresReviewLimit: true } }).fresh.length).toBe(8);
  });

  it("buries a new sibling once another cloze of the same card was answered today", () => {
    const refs = refsForNote("Deck/S.md", "Deck", parseNote("A ==one== and ==two==. ^fc-sib00000"), 0);
    const ev: LogEvent[] = [{ ts: "2026-09-27T11:00:00.000Z", type: "review", key: refs[0].key!, rating: "good", ms: 1, hash: "0", device: "m" }];
    const st = replay(ev, opts);
    const its = refs.map((ref) => ({ ref, state: ref.key ? st.get(ref.key) : undefined }));
    const off = buildQueue(its, now, DEFAULT_QUEUE);
    const on = buildQueue(its, now, { ...DEFAULT_QUEUE, bury: { newSiblings: true, reviewSiblings: true, learningSiblings: true } });
    expect(off.fresh.length).toBe(1);
    expect(on.fresh.length).toBe(0);
  });
});

describe("same-day miss cap and adaptive new cards (0.21.0)", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const agains = (key: string, n: number): LogEvent[] => Array.from({ length: n }, (_, i) => rev(`2026-09-27T11:5${i}:00.000Z`, key, "again"));

  it("rests a card after N misses today, and brings it back the next day", () => {
    const events = [...agains(keyOf(0), 3), ...agains(keyOf(1), 2)];
    const off = buildQueue(items(3, events), now, DEFAULT_QUEUE);
    expect(off.learning).toHaveLength(2);
    expect(off.rested).toBe(0);
    const on = buildQueue(items(3, events), now, { ...DEFAULT_QUEUE, missCap: 3 });
    expect(on.learning.map((i) => i.ref.card.front)).toEqual([expect.stringContaining("Fact 1")]);
    expect(on.rested).toBe(1);
    // Tomorrow the misses no longer count, and the card is due at once.
    const tomorrow = buildQueue(items(3, events), new Date("2026-09-28T12:00:00.000Z"), { ...DEFAULT_QUEUE, missCap: 3 });
    expect(tomorrow.rested).toBe(0);
    expect([...tomorrow.learning, ...tomorrow.review].some((i) => i.ref.card.front.includes("Fact 0"))).toBe(true);
  });

  it("holds new cards back while the learning pile is above the limit, and releases them after", () => {
    const events = [0, 1, 2].flatMap((i) => agains(keyOf(i), 1));
    const all = items(10, events);
    const off = buildQueue(all, now, DEFAULT_QUEUE);
    expect(off.fresh).toHaveLength(7);
    const paused = buildQueue(all, now, { ...DEFAULT_QUEUE, newPauseAbove: 2 });
    expect(paused.pile).toBe(3);
    expect(paused.fresh).toHaveLength(0);
    expect(paused.newHeld).toBe(7);
    expect(paused.learning).toHaveLength(3);
    const fine = buildQueue(all, now, { ...DEFAULT_QUEUE, newPauseAbove: 3 });
    expect(fine.fresh).toHaveLength(7);
    expect(fine.newHeld).toBe(0);
    // A card left in learning since an earlier day isn't part of today's pile.
    const stale = buildQueue(items(10, [rev("2026-09-20T11:50:00.000Z", keyOf(0), "again"), ...agains(keyOf(1), 1)]), now, { ...DEFAULT_QUEUE, newPauseAbove: 1 });
    expect(stale.learning).toHaveLength(2);
    expect(stale.pile).toBe(1);
    expect(stale.fresh.length).toBeGreaterThan(0);
    // Rested cards are off the pile, so they don't keep new cards paused.
    const rested = buildQueue(items(10, [...agains(keyOf(0), 3), ...agains(keyOf(1), 1)]), now, { ...DEFAULT_QUEUE, missCap: 3, newPauseAbove: 1 });
    expect(rested.pile).toBe(1);
    expect(rested.fresh.length).toBeGreaterThan(0);
  });
});

describe("studying only some kinds of card (new / learning / review)", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  const only = (...k: CardKind[]) => new Set<CardKind>(k);
  // Card 0 is due for review, cards 1-2 were missed a minute ago (learning), the rest are new.
  const events = [
    rev("2026-08-01T10:00:00.000Z", keyOf(0)), rev("2026-08-01T10:10:00.000Z", keyOf(0)),
    rev("2026-09-27T11:58:00.000Z", keyOf(1), "again"), rev("2026-09-27T11:58:30.000Z", keyOf(2), "again"),
  ];
  const full = () => buildQueue(items(8, events), now, DEFAULT_QUEUE);

  it("all three kinds on is the queue unchanged", () => {
    const q = full();
    expect(counts(q)).toEqual({ fresh: 5, learning: 2, review: 1 });
    expect(restrictQueue(q, only("fresh", "learning", "review"))).toBe(q);
  });

  it("keeps only the chosen kinds and says how many of the others are waiting", () => {
    const q = full();
    const greens = restrictQueue(q, only("review"));
    expect(counts(greens)).toEqual({ fresh: 0, learning: 0, review: 1 });
    expect(greens.skipped).toEqual({ fresh: 5, learning: 2, review: 0 });
    const noReds = restrictQueue(q, only("fresh", "review"));
    expect(counts(noReds)).toEqual({ fresh: 5, learning: 0, review: 1 });
    expect(noReds.skipped).toEqual({ fresh: 0, learning: 2, review: 0 });
    const reds = restrictQueue(q, only("learning"));
    expect(counts(reds)).toEqual({ fresh: 0, learning: 2, review: 0 });
    // The full queue is left as it was: nothing is rescheduled, buried or dropped.
    expect(counts(q)).toEqual({ fresh: 5, learning: 2, review: 1 });
  });

  it("never serves a card of a kind that is off, and ends when the chosen kinds run out", () => {
    const noReds = restrictQueue(full(), only("fresh", "review"));
    const seen: string[] = [];
    for (let n = 0; n < 20; n++) {
      const next = nextCard(noReds, now, n);
      if (!next) break;
      seen.push(next.ref.card.front);
      noReds.fresh = noReds.fresh.filter((i) => i !== next);
      noReds.review = noReds.review.filter((i) => i !== next);
    }
    expect(seen).toHaveLength(6);
    expect(seen.some((f) => f.includes("Fact 1") || f.includes("Fact 2"))).toBe(false);
    expect(nextCard(restrictQueue(full(), only("review")), now, 1)?.ref.card.front).toContain("Fact 0");
  });

  it("with learning off, a learning card coming due later doesn't keep the session waiting", () => {
    // Missed just now: due in a minute, then within the learn-ahead limit.
    const later = buildQueue(items(3, [rev("2026-09-27T11:59:50.000Z", keyOf(0), "again")]), now, { ...DEFAULT_QUEUE, learnAheadMins: 0 });
    expect(later.nextLearningDue).toBeDefined();
    expect(restrictQueue(later, only("fresh", "review")).nextLearningDue).toBeUndefined();
    expect(restrictQueue(later, only("learning")).nextLearningDue).toEqual(later.nextLearningDue);
    const due = buildQueue(items(8, events), new Date("2026-09-27T12:05:00.000Z"), DEFAULT_QUEUE);
    expect(nextCard(due, new Date("2026-09-27T12:05:00.000Z"), 0)?.ref.card.front).toContain("Fact 1");
    expect(nextCard(restrictQueue(due, only("fresh", "review")), new Date("2026-09-27T12:05:00.000Z"), 0)?.ref.card.front).not.toMatch(/Fact [12] /);
  });

  it("leaves the daily limits alone: the same new cards as in the full queue", () => {
    // Two of today's four new cards were already studied (cards 1 and 2).
    const q = buildQueue(items(40, events), now, { ...DEFAULT_QUEUE, newPerDay: 4 });
    expect(q.fresh).toHaveLength(2);
    expect(restrictQueue(q, only("fresh")).fresh).toEqual(q.fresh);
  });

  it("adaptive new cards still pauses new cards, and held cards aren't shown when new is off", () => {
    const q = buildQueue(items(8, events), now, { ...DEFAULT_QUEUE, newPauseAbove: 1 });
    expect(q.newHeld).toBe(5);
    const blues = restrictQueue(q, only("fresh"));
    expect(blues.fresh).toHaveLength(0);
    expect(blues.newHeld).toBe(5);
    expect(blues.pile).toBe(2);
    const greens = restrictQueue(q, only("review"));
    expect(greens.newHeld).toBe(0);
    expect(greens.skipped).toEqual({ fresh: 0, learning: 2, review: 0 });
  });
});
