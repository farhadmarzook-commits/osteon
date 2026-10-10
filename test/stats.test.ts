import { describe, expect, it } from "vitest";
import { refsForNote } from "../src/core/collection";
import type { LogEvent } from "../src/core/log";
import { parseNote } from "../src/core/parser";
import type { QueueItem } from "../src/core/queue";
import { DEFAULT_SCHEDULER, makeScheduler } from "../src/core/scheduler";
import { replay } from "../src/core/state";
import {
  activityByDay,
  answerButtons,
  cardCounts,
  cardsPerMinute,
  difficultyPct,
  forecast,
  heatLevel,
  heatmapThresholds,
  histogram,
  hourly,
  percentLevel,
  percentile,
  periodSummary,
  reviewRows,
  reviewsByDay,
  streakLevel,
  streakStats,
  studyDay,
  todaySummary,
  trueRetention,
} from "../src/core/stats";

const f = makeScheduler({ ...DEFAULT_SCHEDULER, fuzz: false });
const opts = { schedulerFor: () => f, dayStartHour: 4 };
const KEY = (i: number) => `${String(i).padStart(8, "0")}.xyz`;
const rev = (ts: string, i: number, rating: "again" | "hard" | "good" | "easy" = "good", ms = 6000): LogEvent => ({
  ts,
  type: "review",
  key: KEY(i),
  rating,
  ms,
  hash: "0000",
  device: "mac",
});
const day = (iso: string) => studyDay(Date.parse(iso), 4);

describe("study days", () => {
  it("start at 4 am, like Anki", () => {
    expect(day("2026-09-27T03:59:00Z")).toBe(day("2026-09-26T12:00:00Z"));
    expect(day("2026-09-27T04:00:00Z")).toBe(day("2026-09-26T12:00:00Z") + 1);
  });
});

describe("review rows", () => {
  it("classifies learn, young, mature and relearn by the interval at answer time", () => {
    const events = [
      rev("2026-01-01T10:00:00Z", 1), // new → learning
      rev("2026-01-01T10:10:00Z", 1), // learning → review
      rev("2026-01-01T10:20:00Z", 1, "easy"),
    ];
    // A second card with a long interval before its answer.
    let t = Date.parse("2026-01-01T10:00:00Z");
    for (let i = 0; i < 8; i++) {
      events.push(rev(new Date(t).toISOString(), 2, "easy"));
      t += 120 * 86400000;
    }
    events.push(rev(new Date(t).toISOString(), 2, "again"));
    events.push(rev(new Date(t + 600000).toISOString(), 2, "good"));
    const rows = reviewRows(replay(events, opts).values(), 4);
    const kinds = rows.filter((r) => r.key === KEY(2)).map((r) => r.kind);
    expect(kinds[0]).toBe("learn");
    expect(kinds).toContain("mature");
    expect(kinds[kinds.length - 1]).toBe("relearn");
    expect(rows.filter((r) => r.key === KEY(1)).map((r) => r.kind)).toEqual(["learn", "learn", "young"]);
  });
});

describe("heatmap stats (Review Heatmap add-on)", () => {
  const today = 1000;
  it("computes streaks, days learned and the daily average", () => {
    const a = new Map<number, number>([
      [990, 10],
      [991, 20],
      [992, 30],
      [995, 40],
      [999, 50],
    ]);
    const s = streakStats(a, today);
    expect(s.longestStreak).toBe(3);
    expect(s.currentStreak).toBe(1); // yesterday counts
    expect(s.dailyAvg).toBe(30);
    expect(s.pctDaysLearned).toBe(Math.round((5 / 11) * 100));
  });
  it("drops the current streak after a missed day", () => {
    expect(streakStats(new Map([[997, 5], [998, 5]]), today).currentStreak).toBe(0);
    expect(streakStats(new Map([[999, 5], [1000, 5]]), today).currentStreak).toBe(2);
  });
  it("has no stats without history", () => {
    expect(streakStats(new Map(), today)).toEqual({ dailyAvg: 0, pctDaysLearned: 0, longestStreak: 0, currentStreak: 0 });
  });
  it("colours days relative to the average", () => {
    const th = heatmapThresholds(273);
    expect(heatLevel(0, th)).toBe(0);
    expect(heatLevel(273, th)).toBe(5);
    expect(heatLevel(5000, th)).toBe(10);
    expect(heatmapThresholds(3)[4]).toBe(20); // floor of 20
  });
  it("colours the stats on the add-on's scales", () => {
    expect(streakLevel(218)).toBe(10);
    expect(streakLevel(21)).toBe(4);
    expect(percentLevel(36)).toBe(2);
    expect(percentLevel(100)).toBe(10);
  });
});

function itemsFrom(n: number, events: LogEvent[]): QueueItem[] {
  const text = Array.from({ length: n }, (_, i) => `Fact ${i} is ==answer ${i}==. ^fc-${String(i).padStart(8, "0")}`).join("\n\n");
  const refs = refsForNote("D/N.md", "D", parseNote(text), 0);
  const states = replay(events.map((e) => ({ ...e, key: refs[Number(e.key.split(".")[0])].key! })), opts);
  return refs.map((ref) => ({ ref, state: ref.key ? states.get(ref.key) : undefined }));
}

describe("card counts and forecast", () => {
  it("splits cards into Anki's groups", () => {
    const items = itemsFrom(3, [rev("2026-01-01T10:00:00Z", 1)]);
    const c = cardCounts(items, Date.parse("2026-01-01T11:00:00Z"));
    expect(c.new).toBe(2);
    expect(c.learning).toBe(1);
  });
  it("puts overdue cards on today", () => {
    const items = itemsFrom(2, [rev("2026-01-01T10:00:00Z", 0), rev("2026-01-01T10:10:00Z", 0)]);
    const today = day("2026-03-01T12:00:00Z");
    expect(forecast(items, today, 4).get(today)).toBe(1);
    expect(forecast(items, today, 4, false).size).toBe(0);
  });
});

describe("today, reviews, hourly, buttons, retention", () => {
  const events = [
    rev("2026-01-01T10:00:00Z", 1, "again", 3000),
    rev("2026-01-01T10:01:00Z", 1, "good", 9000),
    rev("2026-01-03T15:00:00Z", 2, "good", 6000),
  ];
  const rows = reviewRows(replay(events, opts).values(), 4);
  it("summarises today", () => {
    const t = todaySummary(rows, day("2026-01-01T12:00:00Z"));
    expect(t).toMatchObject({ cards: 2, ms: 12000, again: 1, learn: 2 });
  });
  it("fills every day of a period", () => {
    const from = day("2026-01-01T12:00:00Z");
    const r = reviewsByDay(rows, from, from + 2);
    expect(r.map((d) => d.count.learn)).toEqual([2, 0, 1]);
    const p = periodSummary(r.map((d) => d.count.learn));
    expect(p).toMatchObject({ daysStudied: 2, daysTotal: 3, total: 3, avgStudied: 1.5, avgOverall: 1 });
    expect(activityByDay(rows).get(from)).toBe(2);
  });
  it("breaks answers down by hour and button", () => {
    const h = hourly(rows, 0);
    expect(h[10]).toEqual({ hour: 10, total: 2, correct: 1 });
    expect(answerButtons(rows, 0).learning).toEqual([1, 0, 2, 0]);
  });
  it("reports true retention on review cards only", () => {
    const t = trueRetention(rows, day("2026-01-03T12:00:00Z"));
    expect(t[5]).toEqual({ label: "All time", young: { pass: 0, fail: 0 }, mature: { pass: 0, fail: 0 } });
  });
  it("measures speed in cards per minute", () => {
    expect(cardsPerMinute(rows, day("2026-01-03T12:00:00Z"))).toBeCloseTo(3 / (18000 / 60000));
  });
});

describe("histograms", () => {
  it("bins and clamps", () => {
    const h = histogram([0, 5, 9.9, 10, 50], 0, 10, 2);
    expect(h.map((b) => b.count)).toEqual([1, 4]);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(difficultyPct(1)).toBe(0);
    expect(difficultyPct(10)).toBe(100);
  });
});
