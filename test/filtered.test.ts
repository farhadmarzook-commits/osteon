import { describe, expect, it } from "vitest";
import { buildFiltered, customStudyDeck, filteredQueue, type FilteredDeck } from "../src/core/filtered";
import { refsForNote } from "../src/core/collection";
import type { LogEvent } from "../src/core/log";
import { parseNote } from "../src/core/parser";
import type { QueueItem } from "../src/core/queue";
import { DEFAULT_SCHEDULER, makeScheduler } from "../src/core/scheduler";
import { compileSearch } from "../src/core/search";
import { replay } from "../src/core/state";

const f = makeScheduler({ ...DEFAULT_SCHEDULER, fuzz: false });
const opts = { schedulerFor: () => f, dayStartHour: 4 };
const note = (n: number) => Array.from({ length: n }, (_, i) => `Fact ${i} is ==answer ${i}==. ^fc-${String(i).padStart(8, "0")}`).join("\n\n");
const refs = refsForNote("D/N.md", "D", parseNote(note(5)), 0);
const rev = (ts: string, i: number, rating: "again" | "good" = "good"): LogEvent => ({ ts, type: "review", key: refs[i].key!, rating, ms: 1000, hash: "0000", device: "m" });
const itemsFor = (events: LogEvent[]): QueueItem[] => {
  const s = replay(events, opts);
  return refs.map((ref) => ({ ref, state: ref.key ? s.get(ref.key) : undefined }));
};
const NOW = Date.parse("2026-09-28T15:00:00Z");

describe("filtered decks", () => {
  // Cards 0 and 1 reviewed (0 forgotten yesterday), 2–4 new.
  const events = [rev("2026-09-20T10:00:00Z", 0), rev("2026-09-20T10:05:00Z", 0), rev("2026-09-27T10:00:00Z", 0, "again"), rev("2026-09-20T10:00:00Z", 1), rev("2026-09-20T10:05:00Z", 1)];
  const items = itemsFor(events);

  it("builds a snapshot from a search, in order, with a limit", () => {
    expect(buildFiltered(items, { search: "is:new", limit: 2, order: "notes" }, NOW, 4)).toEqual([refs[2].uid, refs[3].uid]);
    expect(buildFiltered(items, { search: "-is:new", limit: 10, order: "notes" }, NOW, 4)).toEqual([refs[0].key, refs[1].key]);
    expect(buildFiltered(items, { search: "", limit: 10, order: "random" }, NOW, 4)).toHaveLength(5);
  });

  it("finds forgotten cards with rated:N:1", () => {
    const match = compileSearch("rated:2:1", NOW, 4);
    expect(items.filter(match).map((i) => i.ref.key)).toEqual([refs[0].key]);
  });

  it("serves the snapshot as a queue; answered cards leave unless still learning", () => {
    const def: FilteredDeck = { id: "f1", name: "F", search: "", limit: 10, order: "notes", reschedule: true, builtAt: NOW, cards: [refs[0].key!, refs[1].key!, refs[2].uid] };
    let q = filteredQueue(items, def, NOW);
    expect([q.review.length, q.fresh.length, q.learning.length]).toEqual([2, 1, 0]);
    // Card 1 answered Good after the build (graduates out), card 0 answered Again (stays, learning).
    const later = itemsFor([...events, rev("2026-09-28T15:01:00Z", 1), rev("2026-09-28T15:02:00Z", 0, "again")]);
    q = filteredQueue(later, def, NOW + 180000);
    expect(q.review.map((i) => i.ref.key)).toEqual([]);
    expect(q.learning.map((i) => i.ref.key)).toEqual([refs[0].key]);
    expect(q.fresh).toHaveLength(1);
  });

  it("without rescheduling, the session's done set removes cards", () => {
    const def: FilteredDeck = { id: "f1", name: "F", search: "", limit: 10, order: "notes", reschedule: false, builtAt: NOW, cards: [refs[2].uid, refs[3].uid] };
    expect(filteredQueue(items, def, NOW, new Set([refs[2].uid])).fresh.map((i) => i.ref.uid)).toEqual([refs[3].uid]);
  });

  it("makes Anki's Custom Study sessions", () => {
    expect(customStudyDeck("Ortho", "forgotten", 3).search).toBe('deck:"Ortho" rated:3:1');
    expect(customStudyDeck("Ortho", "ahead", 2)).toMatchObject({ search: 'deck:"Ortho" -is:new prop:due<=2', order: "due", reschedule: true });
    expect(customStudyDeck(null, "preview", 10)).toMatchObject({ search: "is:new", limit: 10, reschedule: false });
    expect(customStudyDeck("Ortho", "state", 50, { state: "allRandom", tags: "#hy knee" })).toMatchObject({ search: 'deck:"Ortho" tag:hy tag:knee', reschedule: false });
  });
});
