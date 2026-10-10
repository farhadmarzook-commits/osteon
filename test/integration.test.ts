/**
 * Data-layer integration against an in-memory vault (test/mocks/obsidian.ts): the card index,
 * per-device log files, ID writing, and two devices syncing.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { App } from "./mocks/obsidian";
import { describe, expect, it } from "vitest";
import { insertCardId } from "../src/core/ids";
import type { LogEvent } from "../src/core/log";
import { buildQueue, DEFAULT_QUEUE } from "../src/core/queue";
import { DEFAULT_SCHEDULER, makeScheduler } from "../src/core/scheduler";
import { ReviewState } from "../src/core/state";
import { CardIndex } from "../src/plugin/indexer";
import { deviceId, LogStore, syncLines } from "../src/plugin/logstore";
import { DEFAULT_SETTINGS } from "../src/plugin/settings";

const FIXTURES = join(__dirname, "fixtures/vault");

function loadFixtureVault(app: App): void {
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else app.vault.files.set(relative(FIXTURES, full), readFileSync(full, "utf8"));
    }
  };
  walk(FIXTURES);
}

// The mock only implements what the plugin uses; cast through unknown for the real types.
type RealApp = ConstructorParameters<typeof LogStore>[0];
const real = (app: App) => app as unknown as RealApp;

const f = makeScheduler(DEFAULT_SCHEDULER);
const opts = { schedulerFor: () => f, dayStartHour: 4 };

describe("CardIndex over the fixture vault", () => {
  it("scans #flashcards notes, assigns decks, and keeps note order", async () => {
    const app = new App();
    loadFixtureVault(app);
    const index = new CardIndex(real(app), () => DEFAULT_SETTINGS);
    await index.build();
    const refs = index.refs();
    const decks = [...new Set(refs.map((r) => r.deck))];
    expect(decks).toEqual(["Misc", "ortho/elbow", "Ortho/Knee"]);
    // ACL: 1 cloze + reversed (2) + basic = 4 instances; Radiograph: 5 masks + 1 cloze = 6;
    // Elbow: 1+1+1+1+2 = 6; SR: 2.
    expect(refs).toHaveLength(18);
    expect(refs.map((r) => r.order)).toEqual(refs.map((_, i) => i));
  });

  it("ignores notes without the tag unless their folder is listed", async () => {
    const app = new App();
    app.vault.files.set("Untagged/Note.md", "The ==median nerve== is here.");
    const index = new CardIndex(real(app), () => DEFAULT_SETTINGS);
    await index.build();
    expect(index.refs()).toHaveLength(0);
    const withFolder = new CardIndex(real(app), () => ({ ...DEFAULT_SETTINGS, cardFolders: ["Untagged"] }));
    await withFolder.build();
    expect(withFolder.refs()).toHaveLength(1);
  });
});

describe("LogStore", () => {
  it("creates this device's monthly file with a header and appends to it", async () => {
    const app = new App();
    const store = new LogStore(real(app), () => "Flashcards", "mac-1111");
    const e = (ts: string): LogEvent => ({ ts, type: "review", key: "aaaaaaaa.c1", rating: "good", ms: 3000, hash: "0000" });
    await Promise.all([store.append(e("2026-09-27T10:00:00.000Z")), store.append(e("2026-09-27T10:05:00.000Z"))]);
    await store.append(e("2026-10-01T10:00:00.000Z"));
    const sep = app.vault.files.get("Flashcards/reviews/mac-1111/2026-09.md")!;
    expect(sep.split("\n")[0]).toMatch(/^# fc-review-log v1 · device mac-1111/);
    expect(sep.trim().split("\n")).toHaveLength(4); // header, blank, 2 events
    expect(app.vault.files.has("Flashcards/reviews/mac-1111/2026-10.md")).toBe(true);
    const loaded = await store.loadAll();
    expect(loaded.events).toHaveLength(3);
    expect(loaded.events.every((x) => x.device === "mac-1111")).toBe(true);
  });

  it("keeps a stable per-device ID in local storage", () => {
    const app = new App();
    const id = deviceId(real(app));
    expect(id).toMatch(/^mac-[a-z0-9]{4}$/);
    expect(deviceId(real(app))).toBe(id);
  });
});

describe("two devices sharing one vault (as through iCloud)", () => {
  it("never write the same file, and each sees the union of reviews", async () => {
    const app = new App();
    loadFixtureVault(app);
    const mac = new LogStore(real(app), () => "Flashcards", "mac-1111");
    const phone = new LogStore(real(app), () => "Flashcards", "iphone-2222");
    const rev = (ts: string, rating: "good" | "again"): LogEvent => ({ ts, type: "review", key: "a1b2c3d4." + "xabcd", rating, ms: 3000, hash: "0000" });
    await mac.append(rev("2026-09-01T10:00:00.000Z", "good"));
    await phone.append(rev("2026-09-02T09:00:00.000Z", "again"));
    await mac.append(rev("2026-09-04T10:00:00.000Z", "good"));
    const logWrites = app.vault.writes.filter((p) => p.startsWith("Flashcards/"));
    expect(new Set(logWrites.filter((p) => p.includes("mac-1111"))).size).toBe(1);
    expect(new Set(logWrites.filter((p) => p.includes("iphone-2222"))).size).toBe(1);

    const s1 = new ReviewState(opts);
    s1.load((await mac.loadAll()).events);
    const s2 = new ReviewState(opts);
    s2.load((await phone.loadAll()).events);
    expect(s1.get("a1b2c3d4.xabcd")!.reviews.map((r) => r.rating)).toEqual(["good", "again", "good"]);
    expect(s2.get("a1b2c3d4.xabcd")!.card).toEqual(s1.get("a1b2c3d4.xabcd")!.card);
  });

  it("an iCloud duplicate of a log file does not double-count reviews", async () => {
    const app = new App();
    const phone = new LogStore(real(app), () => "Flashcards", "iphone-2222");
    await phone.append({ ts: "2026-09-02T09:00:00.000Z", type: "review", key: "aaaaaaaa.c1", rating: "good", ms: 1, hash: "0" });
    const path = "Flashcards/reviews/iphone-2222/2026-09.md";
    app.vault.files.set("Flashcards/reviews/iphone-2222/2026-09 2.md", app.vault.files.get(path)!);
    const s = new ReviewState(opts);
    s.load((await phone.loadAll()).events);
    expect(s.get("aaaaaaaa.c1")!.reviews).toHaveLength(1);
  });
});

describe("first review writes the card ID into the note once", () => {
  it("adds ^fc-<id> via process(), then the card keeps its key after re-indexing", async () => {
    const app = new App();
    loadFixtureVault(app);
    const index = new CardIndex(real(app), () => DEFAULT_SETTINGS);
    await index.build();
    const ref = index.refs().find((r) => r.path === "Ortho/Knee/ACL.md" && r.card.type === "cloze")!;
    expect(ref.key).toBeUndefined();
    const file = app.vault.getFileByPath(ref.path)!;
    await app.vault.process(file, (text) => insertCardId(text, ref.card, "k3x9m2qa") ?? text);
    expect(app.vault.files.get(ref.path)).toContain("![[acl-femoral-footprint.png]] ^fc-k3x9m2qa");
    await index.build();
    const again = index.refs().find((r) => r.path === "Ortho/Knee/ACL.md" && r.card.type === "cloze")!;
    expect(again.key).toBe(`k3x9m2qa.${ref.slot}`);
    // Nothing else in the note changed.
    const before = readFileSync(join(FIXTURES, "Ortho/Knee/ACL.md"), "utf8").split("\n");
    const after = app.vault.files.get(ref.path)!.split("\n");
    expect(after.filter((l, i) => l !== before[i])).toEqual(["![[acl-femoral-footprint.png]] ^fc-k3x9m2qa"]);
  });

  it("a full day: new cards → learning → the queue empties as they are learned", async () => {
    const app = new App();
    loadFixtureVault(app);
    const index = new CardIndex(real(app), () => DEFAULT_SETTINGS);
    await index.build();
    const store = new LogStore(real(app), () => "Flashcards", "mac-1111");
    const state = new ReviewState(opts);
    state.load([]);
    let now = new Date("2026-09-27T12:00:00.000Z");
    const items = () => index.refs().map((ref) => ({ ref, state: ref.key ? state.get(ref.key) : undefined }));
    expect(buildQueue(items(), now, DEFAULT_QUEUE).fresh).toHaveLength(18);

    // Answer "good" on every card until nothing is left, advancing the clock 11 minutes per round.
    for (let round = 0; round < 5; round++) {
      const q = buildQueue(items(), now, DEFAULT_QUEUE);
      for (const item of [...q.learning, ...q.fresh]) {
        let key = item.ref.key;
        if (!key) {
          const id = `t${String(item.ref.order).padStart(7, "0")}`;
          const file = app.vault.getFileByPath(item.ref.path)!;
          await app.vault.process(file, (t) => insertCardId(t, item.ref.card, id) ?? t);
          await index.build();
          key = `${item.ref.card.id ?? id}.${item.ref.slot}`;
        }
        const e: LogEvent = { ts: now.toISOString(), type: "review", key, rating: "good", ms: 2000, hash: item.ref.card.hash, device: "mac-1111" };
        await store.append(e);
        state.add(e);
        now = new Date(now.getTime() + 1000);
      }
      now = new Date(now.getTime() + 11 * 60000);
    }
    const q = buildQueue(items(), now, DEFAULT_QUEUE);
    expect(q.fresh.length + q.learning.length + q.review.length).toBe(0);
    // Every card instance now has a key, and siblings share their card's ID.
    expect(index.refs().every((r) => r.key)).toBe(true);
    // Reloading the logs from disk reproduces the same state.
    const reloaded = new ReviewState(opts);
    reloaded.load((await store.loadAll()).events);
    for (const r of index.refs()) expect(reloaded.get(r.key!)!.card).toEqual(state.get(r.key!)!.card);
  });
});

describe("which device wrote what (0.20.0)", () => {
  const rev = (ts: string, rating: "good" | "again" = "good"): LogEvent => ({ ts, type: "review", key: "aaaaaaaa.c1", rating, ms: 3000, hash: "0000" });

  it("writes one session line per session, with the first event, and older parsers skip it", async () => {
    const app = new App();
    const phone = new LogStore(real(app), () => "Flashcards", "iphone-2222", "0.20.0");
    await phone.append(rev("2026-10-04T12:00:00.000Z"));
    await phone.append(rev("2026-10-04T12:01:00.000Z"));
    const text = app.vault.files.get("Flashcards/reviews/iphone-2222/2026-10.md")!;
    expect(text.split("\n").filter((l) => l.startsWith("# session "))).toHaveLength(1);
    expect(text).toMatch(/# session \S+Z · Osteon 0\.20\.0\n2026-10-04T12:00/);
    const loaded = await phone.loadAll();
    expect(loaded.events).toHaveLength(2);
    expect(loaded.bad).toEqual([]);
    expect(loaded.devices["iphone-2222"]).toMatchObject({ last: "2026-10-04T12:01:00.000Z", version: "0.20.0" });
    // A later session on a newer build wins.
    const later = new LogStore(real(app), () => "Flashcards", "iphone-2222", "0.20.1");
    await later.append(rev("2026-10-05T12:00:00.000Z"));
    expect((await later.loadAll()).devices["iphone-2222"].version).toBe("0.20.1");
  });

  it("the deck list names the other devices, newest first, and flags a different version", () => {
    const now = new Date(2026, 9, 4, 20, 0);
    const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString();
    const lines = syncLines(
      { "mac-1111": { last: at(4, 7, 20), version: "0.20.0" }, "iphone-2222": { last: at(4, 19, 46), version: "0.19.8" }, "ipad-3333": { last: at(1, 9, 5) }, "ipad-4444": {} },
      "mac-1111",
      "0.20.0",
      now,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Latest from iPhone: today 7:46\s?PM · that answer was on Osteon 0\.19\.8$/i);
    const d = { "iphone-2222": { last: at(4, 19, 46), version: "0.24.0" } };
    expect(syncLines(d, "mac-1111", "0.24.0", now)[0]).toMatch(/· Osteon 0\.24\.0$/);
    expect(syncLines(d, "mac-1111", "0.9.9", now)[0]).toMatch(/· Osteon 0\.24\.0 \(newer than this device: restart Obsidian here to update\)$/);
    expect(lines[1]).toMatch(/^Latest from iPad: Oct 1, 9:05\s?AM$/i);
  });

  it("undoing the answer that made a card a leech also takes back its suspend", () => {
    const again = rev("2026-10-04T19:35:07.686Z", "again");
    const suspend: LogEvent = { ts: "2026-10-04T19:35:07.688Z", type: "suspend", key: again.key };
    const undoSuspend: LogEvent = { ts: "2026-10-04T19:35:14.353Z", type: "undo", key: again.key, target: suspend.ts };
    const undoAnswer: LogEvent = { ts: "2026-10-04T19:35:14.354Z", type: "undo", key: again.key, target: again.ts };
    const good = rev("2026-10-04T19:35:17.522Z", "good");
    const s = new ReviewState(opts);
    s.load([again, suspend, undoSuspend, undoAnswer, good].map((e) => ({ ...e, device: "iphone-2222" })));
    expect(s.get(again.key)!.suspended).toBe(false);
    expect(s.get(again.key)!.reviews.map((r) => r.rating)).toEqual(["good"]);
  });
});
