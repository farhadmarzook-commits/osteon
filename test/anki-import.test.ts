/**
 * .apkg import (spec 0006): synthetic packages in both formats, built here with sql.js, fflate
 * and Node's zstd, then read and converted.
 */
import { zstdCompressSync } from "node:zlib";
import { zipSync } from "fflate";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { applyCardUpdates, convertCollection, imageSize, isHiddenField, planMediaCopy, referencedMedia, safeMediaName, sourceHash } from "../src/core/anki/convert";
import { parseMediaMap, readApkg, readMedia } from "../src/core/anki/package";
import { parseIoeId, parseIoeSvg } from "../src/core/anki/ioe";
import { parseNote } from "../src/core/parser";
import { cardFaces } from "../src/core/faces";
import { DEFAULT_SCHEDULER, GRADE, makeScheduler, newCard } from "../src/core/scheduler";
import { replay } from "../src/core/state";

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const DECK_ID = 1700000000001;
const SUB_ID = 1700000000002;
const CRT = Math.floor(Date.parse("2026-01-01T04:00:00Z") / 1000);
// A 3x2 PNG header is enough for imageSize().
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 200, 0, 0, 0, 100, 8, 2, 0, 0, 0]);

const MODELS = {
  "1": { name: "Cloze", type: 1, flds: [{ name: "Text", ord: 0 }, { name: "Back Extra", ord: 1 }], tmpls: [{}] },
  "2": { name: "Basic (and reversed card)", type: 0, flds: [{ name: "Front", ord: 0 }, { name: "Back", ord: 1 }], tmpls: [{}, {}] },
  "3": {
    name: "AnKingOverhaul",
    type: 1,
    flds: [{ name: "Text", ord: 0 }, { name: "Extra", ord: 1 }, { name: "Lecture Notes", ord: 2 }],
    tmpls: [{}],
  },
  "4": {
    name: "Image Occlusion",
    type: 1,
    flds: [{ name: "Occlusion", ord: 0 }, { name: "Image", ord: 1 }, { name: "Header", ord: 2 }, { name: "Back Extra", ord: 3 }, { name: "Comments", ord: 4 }],
    tmpls: [{}],
  },
};

const NOTES: Array<[number, string, number, string, string[]]> = [
  [100, "guidCloze", 1, "high_yield Ortho::Knee", ['The ACL originates on the {{c1::lateral femoral condyle}}.', 'Behind the <b>resident\'s ridge</b>.<br><img src="acl.png">']],
  [101, "guidBasic", 2, "", ["Lachman test", "Anterior translation at 30°"]],
  [102, "guidAnking", 3, "", ["{{c1::Pronator quadratus}} and {{c2::FPL}} are AIN-innervated", "Extra fact", "Lecture: forearm"]],
  [103, "guidIO", 4, "", ["{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1:oi=1}}{{c2::image-occlusion:rect:left=20:top=10:width=40:height=20:oi=1}}{{c2::image-occlusion:ellipse:left=.6:top=.6:rx=.05:ry=.05:oi=1}}", '<img src="knee.png">', "Name it", "", ""]],
];

// cards: id, nid, did, ord, type, queue, due, ivl, factor, flags
const CARDS: Array<number[]> = [
  [1000, 100, SUB_ID, 0, 2, 2, 300, 12, 2500, 1],
  [1001, 101, DECK_ID, 0, 0, 0, 1, 0, 0, 0],
  [1002, 101, DECK_ID, 1, 0, -1, 2, 0, 0, 0],
  [1003, 102, DECK_ID, 0, 0, 0, 3, 0, 0, 0],
  [1004, 102, DECK_ID, 1, 0, 0, 4, 0, 0, 0],
  [1005, 103, DECK_ID, 0, 0, 0, 5, 0, 0, 0],
  [1006, 103, DECK_ID, 1, 0, 0, 6, 0, 0, 0],
];

// revlog for the cloze card: learn good, good, then a review "again" and "good".
const REVLOG: Array<number[]> = [
  [Date.parse("2026-09-01T10:00:00Z"), 1000, 3, 5000, 0],
  [Date.parse("2026-09-01T10:10:00Z"), 1000, 3, 4000, 0],
  [Date.parse("2026-09-05T10:00:00Z"), 1000, 1, 9000, 1],
  [Date.parse("2026-09-05T10:10:00Z"), 1000, 3, 3000, 2],
  [Date.parse("2026-09-06T10:00:00Z"), 1000, 0, 0, 4], // manual reschedule: ignored
];

function fillCommon(db: InstanceType<SqlJsStatic["Database"]>) {
  db.run("CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text)");
  db.run("CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text)");
  db.run("CREATE TABLE revlog (id integer primary key, cid integer, usn integer, ease integer, ivl integer, lastIvl integer, factor integer, time integer, type integer)");
  for (const [id, guid, mid, tags, flds] of NOTES) db.run("INSERT INTO notes VALUES (?,?,?,0,0,?,?,'',0,0,'')", [id, guid, mid, tags, flds.join("\x1f")]);
  for (const c of CARDS) db.run("INSERT INTO cards VALUES (?,?,?,?,0,0,?,?,?,?,?,0,0,0,0,0,?,'')", c);
  // A manual reschedule carries its new interval; ivl 0 with ease 0 would mean "Forget".
  for (const [id, cid, ease, time, type] of REVLOG) db.run("INSERT INTO revlog VALUES (?,?,0,?,?,0,0,?,?)", [id, cid, ease, type === 4 ? 5 : 1, time, type]);
}

function legacyApkg(): Uint8Array {
  const db = new SQL.Database();
  db.run("CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text)");
  const decks = { [DECK_ID]: { name: "Ortho Review" }, [SUB_ID]: { name: "Ortho Review::Knee & Hip" } };
  db.run("INSERT INTO col VALUES (1,?,0,0,11,0,0,0,'{}',?,?,'{}','{}')", [CRT, JSON.stringify(MODELS), JSON.stringify(decks)]);
  fillCommon(db);
  const bytes = db.export();
  db.close();
  return zipSync({
    "collection.anki2": bytes,
    media: new TextEncoder().encode(JSON.stringify({ "0": "acl.png", "1": "knee.png" })),
    "0": new Uint8Array([1, 2, 3]),
    "1": PNG,
  });
}

/** protobuf helpers for the anki21b media map and notetype config. */
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
function ld(field: number, bytes: Uint8Array | number[]): number[] {
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
}

function anki21bApkg(): Uint8Array {
  const db = new SQL.Database();
  db.run("CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text)");
  db.run("INSERT INTO col VALUES (1,?,0,0,18,0,0,0,'','','','','')", [CRT]);
  db.run("CREATE TABLE notetypes (id integer primary key, name text, mtime_secs integer, usn integer, config blob)");
  db.run("CREATE TABLE fields (ntid integer, ord integer, name text, config blob)");
  db.run("CREATE TABLE templates (ntid integer, ord integer, name text, mtime_secs integer, usn integer, config blob)");
  db.run("CREATE TABLE decks (id integer primary key, name text, mtime_secs integer, usn integer, common blob, kind blob)");
  for (const [id, m] of Object.entries(MODELS)) {
    const config = new Uint8Array(m.type === 1 ? [0x08, 0x01] : []);
    db.run("INSERT INTO notetypes VALUES (?,?,0,0,?)", [Number(id), m.name, config]);
    m.flds.forEach((f) => db.run("INSERT INTO fields VALUES (?,?,?,x'')", [Number(id), f.ord, f.name]));
    m.tmpls.forEach((_, i) => db.run("INSERT INTO templates VALUES (?,?,'t',0,0,x'')", [Number(id), i]));
  }
  db.run("INSERT INTO decks VALUES (?,?,0,0,x'',x'')", [DECK_ID, "Ortho Review"]);
  db.run("INSERT INTO decks VALUES (?,?,0,0,x'',x'')", [SUB_ID, "Ortho Review\x1fKnee & Hip"]);
  fillCommon(db);
  const bytes = db.export();
  db.close();
  const enc = new TextEncoder();
  const entry = (name: string) => ld(1, [...ld(1, [...enc.encode(name)]), ...varint(2 << 3), ...varint(3)]);
  const mediaMap = new Uint8Array([...entry("acl.png"), ...entry("knee.png")]);
  return zipSync({
    "collection.anki2": new Uint8Array([0]), // dummy, as in real anki21b packages
    "collection.anki21b": zstdCompressSync(bytes),
    media: zstdCompressSync(mediaMap),
    "0": zstdCompressSync(new Uint8Array([1, 2, 3])),
    "1": zstdCompressSync(PNG),
  });
}

describe.each([
  ["legacy (collection.anki2)", legacyApkg],
  ["current (collection.anki21b, zstd, schema 18)", anki21bApkg],
])("reading %s", (_name, make) => {
  it("reads note types, decks, notes, cards, revlog and media", () => {
    const bytes = make();
    const col = readApkg(bytes, SQL);
    expect([...col.decks.values()].sort()).toEqual(["Ortho Review", "Ortho Review::Knee & Hip"]);
    expect(col.notetypes.get(1)!.kind).toBe("cloze");
    expect(col.notetypes.get(2)!.templates).toBe(2);
    expect(col.notetypes.get(4)!.fields).toEqual(["Occlusion", "Image", "Header", "Back Extra", "Comments"]);
    expect(col.notes).toHaveLength(4);
    expect(col.cards).toHaveLength(7);
    expect(col.revlog).toHaveLength(5);
    expect([...referencedMedia(col)].sort()).toEqual(["acl.png", "knee.png"]);
    const files = readMedia(bytes, col, ["knee.png", "acl.png"]);
    expect(imageSize(files.get("knee.png")!)).toEqual({ width: 200, height: 100 });
    expect([...files.get("acl.png")!]).toEqual([1, 2, 3]);
  });
});

describe("converting to notes", () => {
  let n = 0;
  const run = (opts: Partial<Parameters<typeof convertCollection>[1]> = {}) => {
    n = 0;
    const col = readApkg(legacyApkg(), SQL);
    return convertCollection(col, {
      root: "Anki",
      keepTags: false,
      includeScheduling: true,
      skipGuids: new Set(),
      newId: () => `a${String(n++).padStart(7, "0")}`,
      now: new Date("2026-09-27T12:00:00Z"),
      imageSize: (f) => (f === "knee.png" ? { width: 200, height: 100 } : null),
      random: (() => {
        let x = 0;
        return () => ((x = (x * 9301 + 49297) % 233280) / 233280);
      })(),
      ...opts,
    });
  };

  it("writes one note per deck with the deck tag and media paths", () => {
    const r = run();
    expect(r.files.map((f) => f.path).sort()).toEqual(["Anki/Ortho Review/Knee & Hip.md", "Anki/Ortho Review/Ortho Review.md"]);
    const knee = r.files.find((f) => f.deck === "Ortho Review::Knee & Hip")!;
    expect(knee.content).toContain("tags: [flashcards/Ortho-Review/Knee-Hip]");
    expect(r.media.get("acl.png")).toBe("Anki/media/acl.png");
    expect(r.stats).toMatchObject({ notes: 4, cards: 7, occlusion: 1 });
  });

  it("produces cards our parser reads back, with the right slots and faces", () => {
    const r = run();
    const all = r.files.flatMap((f) => parseNote(f.content));
    const byType = (t: string) => all.filter((c) => c.type === t);
    expect(byType("cloze")).toHaveLength(2);
    expect(byType("reversed")).toHaveLength(1);
    expect(byType("occlusion")).toHaveLength(1);
    const acl = byType("cloze").find((c) => c.front.includes("ACL"))!;
    expect(acl.back).toBe("Behind the **resident's ridge**.\n![[Anki/media/acl.png]]");
    expect(acl.id).toBeDefined();
    const anking = byType("cloze").find((c) => c.front.includes("FPL"))!;
    expect(anking.slots).toEqual(["c1", "c2"]);
    expect(anking.back).toBe("Extra fact\n**Lecture Notes:** Lecture: forearm");
    const rev = byType("reversed")[0];
    expect(cardFaces(rev, "rev")).toMatchObject({ question: "Anterior translation at 30°", answer: "Lachman test" });
  });

  it("converts image occlusion (fractions and pixels) with groups", () => {
    const r = run();
    const io = r.files.flatMap((f) => parseNote(f.content)).find((c) => c.type === "occlusion")!;
    const occ = io.occlusion!;
    expect(occ.image).toBe("Anki/media/knee.png");
    expect(occ.header).toBe("Name it");
    expect(occ.masks).toHaveLength(3);
    // c2's pixel rect (20,10,40,20 on 200x100) → fractions.
    expect(occ.masks[1].coords).toEqual([0.1, 0.1, 0.2, 0.2]);
    expect(occ.groups).toHaveLength(1);
    expect(io.slots).toHaveLength(2);
  });

  it("imports review history so FSRS replays the real answers", () => {
    const r = run();
    const acl = r.files.flatMap((f) => parseNote(f.content)).find((c) => c.front.includes("ACL"))!;
    const key = `${acl.id}.c1`;
    const reviews = r.events.filter((e) => e.key === key && e.type === "review");
    expect(reviews.map((e) => (e.type === "review" ? e.rating : ""))).toEqual(["good", "good", "again", "good"]);
    expect(r.events.some((e) => e.key === key && e.type === "flag")).toBe(true);
    const f = makeScheduler(DEFAULT_SCHEDULER);
    const s = replay(r.events.map((e) => ({ ...e, device: "mac" })), { schedulerFor: () => f, dayStartHour: 4 }).get(key)!;
    let card = newCard(new Date(REVLOG[0][0]));
    for (const [ts, , ease] of REVLOG.slice(0, 4)) card = f.next(card, new Date(ts), GRADE[(["", "again", "hard", "good", "easy"] as const)[ease] as "good"]).card;
    expect(s.card).toEqual(card);
    // The suspended reverse card stays suspended.
    const rev = r.files.flatMap((f) => parseNote(f.content)).find((c) => c.type === "reversed")!;
    expect(r.events.some((e) => e.key === `${rev.id}.rev` && e.type === "suspend")).toBe(true);
  });

  it("skips notes already imported, and can leave scheduling out", () => {
    const again = run({ skipGuids: new Set(["guidCloze", "guidBasic"]) });
    expect(again.stats.skipped).toBe(2);
    expect(again.stats.notes).toBe(2);
    expect(run({ includeScheduling: false }).events).toHaveLength(0);
  });

  it("keeps Anki tags as card tags when asked", () => {
    const r = run({ keepTags: true });
    const acl = r.files.flatMap((f) => parseNote(f.content)).find((c) => c.front.includes("ACL"))!;
    expect(acl.tags).toEqual(["high_yield", "Ortho/Knee"]);
  });
});

describe("media map", () => {
  it("parses the legacy JSON map", () => {
    expect([...parseMediaMap(new TextEncoder().encode('{"0":"a.png"}'))]).toEqual([["a.png", "0"]]);
  });
});

describe("fixes for real-deck edge cases", () => {
  const nt = (id: number, name: string, kind: "normal" | "cloze", fields: string[], templates = 1) => [id, { id, name, kind, fields, templates }] as const;
  const baseCol = () => ({
    crt: CRT,
    notetypes: new Map([
      nt(1, "Cloze", "cloze", ["Text", "Back Extra"]),
      nt(2, "Basic", "normal", ["Front", "Back"]),
      nt(4, "Image Occlusion", "cloze", ["Occlusion", "Image", "Header", "Back Extra", "Comments"]),
      nt(5, "Image Occlusion Enhanced", "normal", ["ID (hidden)", "Header", "Image", "Question Mask", "Footer", "Remarks", "Sources", "Extra 1", "Extra 2", "Answer Mask", "Original Mask"]),
    ]),
    decks: new Map([[1, "D"]]),
    notes: [] as Array<{ id: number; guid: string; mid: number; tags: string[]; fields: string[] }>,
    cards: [] as Array<{ id: number; nid: number; did: number; ord: number; type: number; queue: number; due: number; ivl: number; factor: number; flags: number }>,
    revlog: [] as Array<{ id: number; cid: number; ease: number; ivl: number; time: number; type: number }>,
    mediaIndex: new Map<string, string>(),
    format: "legacy" as const,
  });
  const add = (col: ReturnType<typeof baseCol>, id: number, mid: number, fields: string[], ords = [0]) => {
    col.notes.push({ id, guid: `g${id}`, mid, tags: [], fields });
    ords.forEach((ord) => col.cards.push({ id: id * 10 + ord, nid: id, did: 1, ord, type: 0, queue: 0, due: 0, ivl: 0, factor: 0, flags: 0 }));
  };
  let n = 0;
  const conv = (col: ReturnType<typeof baseCol>) =>
    convertCollection(col, { root: "Anki", keepTags: false, includeScheduling: true, skipGuids: new Set(), newId: () => `z${String(n++).padStart(7, "0")}`, now: new Date("2026-09-27T12:00:00Z") });
  const cardsOf = (r: ReturnType<typeof conv>) => r.files.flatMap((f) => parseNote(f.content));

  it("keeps a cloze that contains a line break", () => {
    const col = baseCol();
    add(col, 1, 1, ["Signs: {{c1::fever<br>chills}} and {{c2::rash}}", ""], [0, 1]);
    const [c] = cardsOf(conv(col));
    expect(c.slots).toEqual(["c1", "c2"]);
    expect(c.front).toContain("{{c1::fever <br> chills}}");
  });

  it("a front that starts like a list item stays one card with its back and ID", () => {
    const col = baseCol();
    add(col, 1, 1, ["<ul><li>{{c1::Ottawa}} rules</li></ul>", "Back line"]);
    add(col, 2, 2, ["2. Which nerve?", "AIN"]);
    const r = conv(col);
    const cards = cardsOf(r);
    expect(cards.map((c) => c.form)).toEqual(["paragraph", "paragraph"]);
    expect(cards.every((c) => c.id)).toBe(true);
    expect(cards[0].back).toBe("Back line");
    expect(r.stats.unsupported).toBe(0);
  });

  it("escapes ::: in backs, decodes &amp; in image names, and survives a bare % in a filename", () => {
    const col = baseCol();
    add(col, 1, 2, ["Q", 'ratio a:::b <img src="a&amp;b.png"> <img src="100%.png">']);
    const r = conv(col);
    expect(cardsOf(r)).toHaveLength(1);
    expect(r.media.has("a&b.png")).toBe(true);
    expect(r.media.has("100%.png")).toBe(true);
  });

  it("image occlusion defaults to hide-one unless Anki wrote oi=1", () => {
    const col = baseCol();
    add(col, 1, 4, ["{{c1::image-occlusion:rect:left=.1:top=.1:width=.2:height=.2}}", '<img src="x.png">', "", "", ""]);
    expect(cardsOf(conv(col))[0].occlusion!.mode).toBe("hide-one");
  });

  it("skips old Image Occlusion Enhanced notes whose mask SVG can't be read, and counts them", () => {
    const col = baseCol();
    add(col, 1, 5, ["f1-ao-1", "Header", '<img src="x.png">', '<img src="q.svg">', "", "", "", "", "", '<img src="a.svg">', '<img src="f1-ao-O.svg">']);
    const r = conv(col);
    expect(r.files).toHaveLength(0);
    expect(r.stats.empty + r.stats.unsupported).toBe(1);
  });

  it("merges old Image Occlusion Enhanced notes of one figure into one occlusion block, keeping history", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><g><title>Masks</title>
      <rect id="f1-ao-1" x="20" y="10" width="40" height="20" fill="#FFEBA2"/>
      <ellipse id="f1-ao-2" cx="150" cy="50" rx="10" ry="20"/>
      <polyline id="f1-ao-9" points="1,1 "/>
      <g id="f1-ao-3"><rect x="0" y="80" width="20" height="10"/><rect x="100" y="80" width="20" height="10"/></g>
    </g></svg>`;
    const col = baseCol();
    const fields = (n: number, remark: string) => [`f1-ao-${n}`, "Knee", '<img src="knee.png">', `<img src="f1-ao-${n}-Q.svg">`, "", remark, "", "", "", "", '<img src="f1-ao-O.svg">'];
    add(col, 1, 5, fields(1, "Shared remark"));
    add(col, 2, 5, fields(2, "Shared remark"));
    add(col, 3, 5, fields(3, "Group remark"));
    col.revlog.push({ id: Date.parse("2026-09-01T10:00:00Z"), cid: 20, ease: 3, ivl: 1, time: 4000, type: 0 });
    const r = convertCollection(col, {
      root: "Anki",
      keepTags: false,
      includeScheduling: true,
      skipGuids: new Set(),
      newId: () => `z${String(n++).padStart(7, "0")}`,
      now: new Date("2026-09-27T12:00:00Z"),
      readText: (f) => (f === "f1-ao-O.svg" ? svg : null),
    });
    const cards = cardsOf(r);
    expect(cards).toHaveLength(1);
    const occ = cards[0].occlusion!;
    expect(occ.mode).toBe("hide-all");
    expect(occ.header).toBe("Knee");
    expect(occ.image).toBe("Anki/media/knee.png");
    expect(occ.masks.map((m) => m.shape)).toEqual(["rect", "ellipse", "rect", "rect"]);
    expect(occ.masks[0].coords).toEqual([0.1, 0.1, 0.2, 0.2]);
    expect(occ.masks[1].coords).toEqual([0.7, 0.3, 0.1, 0.4]);
    expect(occ.groups).toHaveLength(1);
    expect(cards[0].slots).toHaveLength(3);
    // Every Anki note maps to the one card ID; the reviewed note's history lands on its box.
    expect(r.files[0].guids).toEqual(["g1", "g2", "g3"]);
    expect(new Set(r.files[0].ids).size).toBe(1);
    expect(r.stats).toMatchObject({ notes: 3, cards: 3, withHistory: 1, empty: 0 });
    const review = r.events.find((e) => e.type === "review")!;
    expect(review.key).toBe(`${cards[0].id}.${occ.masks[1].id}`);
    expect(cards[0].back).toContain("Shared remark");
    expect(cards[0].back.match(/Shared remark/g)).toHaveLength(1);
  });

  it("links macOS screenshot names the way Obsidian writes them (U+202F → space)", () => {
    expect(safeMediaName("Screenshot 2025-03-23 at 4.31.12 PM.png")).toBe("Screenshot 2025-03-23 at 4.31.12 PM.png");
    const col = baseCol();
    add(col, 1, 2, ['Q <img src="Shot 1.2.3 PM.png">', "A"]);
    const r = conv(col);
    expect([...r.media.values()]).toEqual(["Anki/media/Shot 1.2.3 PM.png"]);
    expect(r.files[0].content).toContain("![[Anki/media/Shot 1.2.3 PM.png]]");
  });

  it("leaves out machine fields and shows Extra first, unlabelled, as Anki does", () => {
    const col = baseCol();
    col.notetypes.set(6, { id: 6, name: "AnKingOverhaul", kind: "cloze", fields: ["Text", "Lecture Notes", "Extra", "One by one", "ankihub_id"], templates: 1 });
    add(col, 1, 6, ["The {{c1::AIN}} supplies FPL", "9", "Tested with the OK sign", "y", "7ced-1234"]);
    const [c] = cardsOf(conv(col));
    expect(c.back).toBe("Tested with the OK sign");
    expect(isHiddenField("Lecture Notes", "Lecture: forearm")).toBe(false);
  });

  it("update by re-import: rebuilds known notes with their existing ID instead of adding them", () => {
    const col = baseCol();
    add(col, 1, 2, ["Old question", "Old answer"]);
    add(col, 2, 2, ["Brand new", "Card"]);
    const first = conv(col);
    const known = new Map(first.guids.slice(0, 1).map((g) => [g.guid, g.id]));
    col.notes[0].fields = ["New question", "Better answer"];
    const r = convertCollection(col, { root: "Anki", keepTags: false, includeScheduling: true, skipGuids: new Set(known.keys()), updateIds: known, newId: () => `y${String(n++).padStart(7, "0")}`, now: new Date("2026-09-28T12:00:00Z") });
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0].id).toBe(first.guids[0].id);
    expect(r.updates[0].lines.join("\n")).toContain("New question");
    expect(r.updates[0].lines.join("\n")).toContain(`^fc-${first.guids[0].id}`);
    expect(r.files.flatMap((f) => f.guids)).toEqual([first.guids[1].guid]); // only the new note is added
    expect(r.events.every((e) => !e.key.startsWith(first.guids[0].id))).toBe(true); // no history re-imported
  });

  it("applies updates in place, keeping IDs and leaving unchanged cards alone", () => {
    const text = ["# Deck", "", "Q one :: A one ^fc-aaaaaaaa", "", "Q two :: A two ^fc-bbbbbbbb", "Extra line", "", "Q three :: A three ^fc-cccccccc"].join("\n");
    const out = applyCardUpdates(
      text,
      new Map([
        ["aaaaaaaa", ["Q one :: A one ^fc-aaaaaaaa"]],
        ["bbbbbbbb", ["Q two, reworded :: A two ^fc-bbbbbbbb", "New extra", "Second extra"]],
        ["zzzzzzzz", ["missing :: card ^fc-zzzzzzzz"]],
      ]),
    );
    expect(out.changed).toEqual(["bbbbbbbb"]);
    expect(out.text).toBe(["# Deck", "", "Q one :: A one ^fc-aaaaaaaa", "", "Q two, reworded :: A two ^fc-bbbbbbbb", "New extra", "Second extra", "", "Q three :: A three ^fc-cccccccc"].join("\n"));
  });

  it("plans which Anki media to copy for a deck imported without pictures", () => {
    const anki = ["Shot 1.2.3\u202fPM.png", "a:b.png", "plain.webp", "unused.png"];
    const { copy, notFound } = planMediaCopy(["Shot 1.2.3 PM.png", "a-b.png", "plain.webp", "gone.png", "plain.webp"], anki);
    expect(copy).toEqual([
      ["Shot 1.2.3\u202fPM.png", "Shot 1.2.3 PM.png"],
      ["a:b.png", "a-b.png"],
      ["plain.webp", "plain.webp"],
    ]);
    expect(notFound).toEqual(["gone.png"]);
  });

  it("records each note's AnkiHub ID for link tables", () => {
    const col = baseCol();
    col.notetypes.set(6, { id: 6, name: "AnKingOverhaul", kind: "cloze", fields: ["Text", "Extra", "ankihub_id"], templates: 1 });
    add(col, 1, 6, ["The {{c1::AIN}} supplies FPL", "", "0F2C8A7E-1D2B-4C3D-9E8F-A1B2C3D4E5F6"]);
    add(col, 1, 6, ["The {{c1::PIN}} supplies EPL", "", "not-a-uuid"]);
    const f = conv(col).files[0];
    expect(f.hubs).toEqual(["0f2c8a7e-1d2b-4c3d-9e8f-a1b2c3d4e5f6", ""]);
    expect(f.guids).toHaveLength(2);
  });

  it("reads hide-one figures and IDs", () => {
    expect(parseIoeId("abc-oa-12")).toEqual({ figure: "abc", hideAll: false, n: 12 });
    expect(parseIoeId("nope")).toBeNull();
    const m = parseIoeSvg('<svg height="10" width="20"><polygon id="a-oa-1" points="0,0 20,0 10,10"/></svg>')!;
    expect(m.boxes.get("a-oa-1")![0]).toEqual({ shape: "poly", coords: [0, 0, 1, 0, 0.5, 1] });
  });

  it("an Anki 'Forget' resets the card before later answers", () => {
    const col = baseCol();
    add(col, 1, 2, ["Q", "A"]);
    col.revlog.push(
      { id: Date.parse("2026-09-01T10:00:00Z"), cid: 10, ease: 3, ivl: 1, time: 1000, type: 0 },
      { id: Date.parse("2026-09-10T10:00:00Z"), cid: 10, ease: 0, ivl: 0, time: 0, type: 4 },
      { id: Date.parse("2026-09-11T10:00:00Z"), cid: 10, ease: 3, ivl: 1, time: 1000, type: 0 },
    );
    const r = conv(col);
    expect(r.events.map((e) => e.type)).toEqual(["review", "reset", "review"]);
  });
});

describe("re-import keeps cards edited in Obsidian (0.19.3)", () => {
  const imported = "A {{c1::old}} ^fc-aaaaaaaa\n\nB {{c1::old}} ^fc-bbbbbbbb";
  const sources = new Map([
    ["aaaaaaaa", sourceHash(["A {{c1::old}} ^fc-aaaaaaaa"])],
    ["bbbbbbbb", sourceHash(["B {{c1::old}} ^fc-bbbbbbbb"])],
  ]);
  const updates = new Map([
    ["aaaaaaaa", ["A {{c1::new}} ^fc-aaaaaaaa"]],
    ["bbbbbbbb", ["B {{c1::new}} ^fc-bbbbbbbb"]],
  ]);
  it("an untouched card is updated; one edited since import is kept", () => {
    const edited = imported.replace("B {{c1::old}}", "B {{c1::my fix}}");
    const r = applyCardUpdates(edited, updates, sources);
    expect(r.changed).toEqual(["aaaaaaaa"]);
    expect(r.kept).toEqual(["bbbbbbbb"]);
    expect(r.text).toBe("A {{c1::new}} ^fc-aaaaaaaa\n\nB {{c1::my fix}} ^fc-bbbbbbbb");
  });
  it("without fingerprints (or with the switch off) every changed card is updated, as before", () => {
    const edited = imported.replace("B {{c1::old}}", "B {{c1::my fix}}");
    expect(applyCardUpdates(edited, updates).changed).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  });
});
