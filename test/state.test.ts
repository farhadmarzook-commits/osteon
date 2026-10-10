import { State } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { formatEvent, parseEvent, parseLog, type LogEvent, logHeader } from "../src/core/log";
import { DEFAULT_SCHEDULER, GRADE, makeScheduler, newCard } from "../src/core/scheduler";
import { replay, ReviewState } from "../src/core/state";

const f = makeScheduler(DEFAULT_SCHEDULER);
const opts = { schedulerFor: () => f, dayStartHour: 4 };

function review(ts: string, key: string, rating: "again" | "hard" | "good" | "easy", device = "mac-aaaa"): LogEvent {
  return { ts, type: "review", key, rating, ms: 4000, hash: "ab12", device };
}

describe("log format", () => {
  it("round-trips every event type", () => {
    const events: LogEvent[] = [
      { ts: "2026-09-27T20:15:03.412Z", type: "review", key: "k3x9m2qa.c1", rating: "good", ms: 4200, hash: "9f3a" },
      { ts: "2026-09-27T20:16:40.001Z", type: "suspend", key: "p0d7w1te.fwd" },
      { ts: "2026-09-27T20:16:41.001Z", type: "reschedule", key: "p0d7w1te.fwd", due: "2026-10-01T04:00:00.000Z" },
      {
        ts: "2026-09-27T20:16:42.001Z",
        type: "import",
        key: "p0d7w1te.fwd",
        due: "2026-10-01T04:00:00.000Z",
        stability: 12.5,
        difficulty: 5.1,
        lastReview: "2026-09-19T04:00:00.000Z",
      },
      { ts: "2026-09-27T20:16:43.001Z", type: "undo", key: "k3x9m2qa.c1", target: "2026-09-27T20:15:03.412Z" },
      { ts: "2026-09-27T20:16:44.001Z", type: "flag", key: "k3x9m2qa.c1", flag: 3 },
      { ts: "2026-09-27T20:16:45.001Z", type: "mark", key: "k3x9m2qa.c1", marked: true },
      { ts: "2026-09-27T20:16:46.001Z", type: "alias", key: "k3x9m2qa.x2b3c", from: "k3x9m2qa.x1a2b" },
    ];
    for (const e of events) expect(parseEvent(formatEvent(e))).toEqual(e);
  });

  it("skips malformed lines (e.g. a truncated tail) and reports them, never throwing", () => {
    const text = [
      logHeader("iphone-7q2f"),
      formatEvent(review("2026-09-27T20:15:03.412Z", "k3x9m2qa.c1", "good")),
      "garbage line",
      "2026-09-27T20:15:11.000Z\treview\tp0d7w1te.c1\tgo", // truncated by a half-synced file
    ].join("\n");
    const parsed = parseLog(text, "iphone-7q2f");
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].device).toBe("iphone-7q2f");
    expect(parsed.badLines).toEqual([3, 4]);
  });
});

describe("replay", () => {
  it("matches stepping ts-fsrs by hand", () => {
    const key = "k3x9m2qa.c1";
    const events = [
      review("2026-09-01T10:00:00.000Z", key, "good"),
      review("2026-09-01T10:10:00.000Z", key, "good"),
      review("2026-09-03T10:00:00.000Z", key, "again"),
      review("2026-09-03T10:10:00.000Z", key, "good"),
      review("2026-09-10T10:00:00.000Z", key, "easy"),
    ];
    let card = newCard(new Date(events[0].ts));
    for (const e of events) {
      if (e.type === "review") card = f.next(card, new Date(e.ts), GRADE[e.rating]).card;
    }
    const s = replay(events, opts).get(key)!;
    expect(s.card).toEqual(card);
    expect(s.reviews).toHaveLength(5);
    expect(s.card.lapses).toBe(1);
  });

  it("gives the same result whatever order the files are read in", () => {
    const a = [review("2026-09-01T10:00:00.000Z", "aaaaaaaa.c1", "good", "mac-1111"), review("2026-09-02T10:00:00.000Z", "aaaaaaaa.c1", "hard", "mac-1111")];
    const b = [review("2026-09-01T11:00:00.000Z", "aaaaaaaa.c1", "good", "ios-2222"), review("2026-09-05T10:00:00.000Z", "bbbbbbbb.fwd", "again", "ios-2222")];
    const r1 = replay([...a, ...b], opts);
    const r2 = replay([...b, ...a].reverse(), opts);
    expect([...r1.entries()].sort()).toEqual([...r2.entries()].sort());
  });

  it("two devices reviewing offline equals one device doing the union of reviews", () => {
    const mac = [review("2026-09-01T10:00:00.000Z", "aaaaaaaa.c1", "good", "mac-1111"), review("2026-09-04T10:00:00.000Z", "aaaaaaaa.c1", "good", "mac-1111")];
    const phone = [review("2026-09-02T09:00:00.000Z", "aaaaaaaa.c1", "again", "ios-2222")];
    const merged = replay([...mac, ...phone], opts).get("aaaaaaaa.c1")!;
    const single = replay(
      [...mac, ...phone].map((e) => ({ ...e, device: "one" })),
      opts,
    ).get("aaaaaaaa.c1")!;
    expect(merged.card).toEqual(single.card);
    expect(merged.reviews.map((r) => r.rating)).toEqual(["good", "again", "good"]);
  });

  it("drops duplicate events (iCloud 'file 2.md' copies)", () => {
    const e = review("2026-09-01T10:00:00.000Z", "aaaaaaaa.c1", "good");
    const s = replay([e, { ...e }, e], opts).get("aaaaaaaa.c1")!;
    expect(s.reviews).toHaveLength(1);
  });

  it("undo removes the targeted answer", () => {
    const e1 = review("2026-09-01T10:00:00.000Z", "aaaaaaaa.c1", "good");
    const e2 = review("2026-09-01T10:10:00.000Z", "aaaaaaaa.c1", "again");
    const undo: LogEvent = { ts: "2026-09-01T10:10:05.000Z", type: "undo", key: "aaaaaaaa.c1", target: e2.ts, device: "mac-aaaa" };
    expect(replay([e1, e2, undo], opts).get("aaaaaaaa.c1")!.card).toEqual(replay([e1], opts).get("aaaaaaaa.c1")!.card);
  });

  it("alias merges an edited cloze's old history into its new slot", () => {
    const old = "aaaaaaaa.x1111";
    const neu = "aaaaaaaa.x2222";
    const events: LogEvent[] = [
      review("2026-09-01T10:00:00.000Z", old, "good"),
      review("2026-09-01T10:10:00.000Z", old, "good"),
      { ts: "2026-09-05T08:00:00.000Z", type: "alias", key: neu, from: old, device: "mac-aaaa" },
      review("2026-09-05T10:00:00.000Z", neu, "good"),
    ];
    const states = replay(events, opts);
    expect(states.has(old)).toBe(false);
    expect(states.get(neu)!.reviews).toHaveLength(3);
  });

  it("import seeds a review-state card", () => {
    const s = replay(
      [{ ts: "2026-09-27T10:00:00.000Z", type: "import", key: "aaaaaaaa.c1", due: "2026-10-01T10:00:00.000Z", stability: 12, difficulty: 5, lastReview: "2026-09-19T10:00:00.000Z", device: "mac" }],
      opts,
    ).get("aaaaaaaa.c1")!;
    expect(s.card.state).toBe(State.Review);
    expect(s.card.due.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(s.card.scheduled_days).toBe(12);
  });

  it("suspend, bury and flags are tracked without touching FSRS memory", () => {
    const key = "aaaaaaaa.c1";
    const base = [review("2026-09-01T10:00:00.000Z", key, "good")];
    const s = replay(
      [
        ...base,
        { ts: "2026-09-01T10:01:00.000Z", type: "suspend", key, device: "mac-aaaa" },
        { ts: "2026-09-01T10:02:00.000Z", type: "bury", key, device: "mac-aaaa" },
        { ts: "2026-09-01T10:03:00.000Z", type: "flag", key, flag: 1, device: "mac-aaaa" },
      ],
      opts,
    ).get(key)!;
    expect(s.suspended).toBe(true);
    expect(s.flag).toBe(1);
    // Buried until 4 am the next day (TZ=UTC in tests).
    expect(new Date(s.buriedUntil).toISOString()).toBe("2026-09-02T04:00:00.000Z");
    expect(s.card).toEqual(replay(base, opts).get(key)!.card);
  });
});

describe("ReviewState", () => {
  it("incremental adds equal a full rebuild", () => {
    const events = [
      review("2026-09-01T10:00:00.000Z", "aaaaaaaa.c1", "good"),
      review("2026-09-01T10:05:00.000Z", "bbbbbbbb.fwd", "again"),
      review("2026-09-01T10:10:00.000Z", "aaaaaaaa.c1", "good"),
    ];
    const inc = new ReviewState(opts);
    inc.load([]);
    for (const e of events) inc.add(e);
    const full = new ReviewState(opts);
    full.load(events);
    expect([...inc.states.entries()].sort()).toEqual([...full.states.entries()].sort());
  });

  it("adding an event that a reload already read from disk does not apply it twice", () => {
    const e = review("2026-09-01T10:00:00.000Z", "aaaaaaaa.c1", "good");
    const s = new ReviewState(opts);
    s.load([e]);
    s.add({ ...e });
    expect(s.get("aaaaaaaa.c1")!.reviews).toHaveLength(1);
  });

  it("an out-of-order event (from another device) triggers a correct rebuild", () => {
    const s = new ReviewState(opts);
    s.load([review("2026-09-02T10:00:00.000Z", "aaaaaaaa.c1", "good")]);
    s.add(review("2026-09-01T10:00:00.000Z", "aaaaaaaa.c1", "again", "ios-2222"));
    expect(s.get("aaaaaaaa.c1")!.reviews.map((r) => r.rating)).toEqual(["again", "good"]);
  });
});
