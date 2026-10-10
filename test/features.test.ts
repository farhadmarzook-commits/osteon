import { readFileSync } from "node:fs";
import { join } from "node:path";
import { State } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { answerItems, crownSplit, revealsOneByOne } from "../src/core/faces";
import { DEFAULT_KEYS, mergeSettings } from "../src/plugin/settings";
import { refsForNote } from "../src/core/collection";
import { parseDueInput } from "../src/core/due";
import { cardFaces } from "../src/core/faces";
import { replaceCardSource } from "../src/core/ids";
import type { LogEvent } from "../src/core/log";
import { migrateNote, parseSrComment, srToFsrs } from "../src/core/migrate";
import { imageEmbeds, parseNote } from "../src/core/parser";
import { defaultPreset, presetIdFor } from "../src/core/presets";
import { buildQueue, DEFAULT_QUEUE, type QueueItem } from "../src/core/queue";
import { DEFAULT_SCHEDULER, makeScheduler } from "../src/core/scheduler";
import { compileSearch, tokenize } from "../src/core/search";
import { findLeeches } from "../src/core/leeches";
import { replay } from "../src/core/state";

const fixture = (p: string) => readFileSync(join(__dirname, "fixtures/vault", p), "utf8");
const f = makeScheduler(DEFAULT_SCHEDULER);
const opts = { schedulerFor: () => f, dayStartHour: 4 };

describe("section figures (spec 0002 §5)", () => {
  it("collects images under the card's heading, not its own or other sections'", () => {
    const text = [
      "# Knee",
      "![[knee-overview.png]]",
      "## ACL",
      "The ==ACL== is intra-articular.",
      "![[own-image.png]]",
      "",
      "![[acl-footprint.png|300]]",
      "![](images/acl-mri.jpg)",
      "![[not-an-image.pdf]]",
      "## PCL",
      "![[pcl.png]]",
    ].join("\n");
    const card = parseNote(text)[0];
    expect(card.sectionImages).toEqual(["![[acl-footprint.png|300]]", "![](images/acl-mri.jpg)"]);
    expect(imageEmbeds(card.back)).toEqual(["![[own-image.png]]"]);
  });
});

describe("replaceCardSource (inline editor)", () => {
  it("replaces exactly the card's lines", () => {
    const text = "# H\n\nThe ==ACL== is here.\nBack line.\n\nOther text.";
    const card = parseNote(text)[0];
    const out = replaceCardSource(text, card, "The ==ACL== is intra-articular.\nNew back.\nSecond back line.")!;
    expect(out).toBe("# H\n\nThe ==ACL== is intra-articular.\nNew back.\nSecond back line.\n\nOther text.");
  });

  it("refuses if the note changed meanwhile", () => {
    const text = "The ==ACL== is here.";
    const card = parseNote(text)[0];
    expect(replaceCardSource("The ==PCL== is here.", card, "x")).toBeNull();
  });
});

describe("reversed card with its answer on the lines below", () => {
  it("works in both directions", () => {
    const card = parseNote("Lachman test :::\nAnterior translation at 30°")[0];
    expect(cardFaces(card, "fwd")).toMatchObject({ question: "Lachman test", answer: "Anterior translation at 30°" });
    expect(cardFaces(card, "rev")).toMatchObject({ question: "Anterior translation at 30°", answer: "Lachman test" });
  });
});

describe("set due date input", () => {
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  it("parses 0, N and ranges", () => {
    expect(parseDueInput("0", now, 4)!.getTime()).toBe(now);
    expect(parseDueInput("3", now, 4)!.toISOString()).toBe("2026-09-30T04:00:00.000Z");
    expect(parseDueInput("3-7!", now, 4, () => 0.999)!.toISOString()).toBe("2026-10-04T04:00:00.000Z");
    expect(parseDueInput("7-3", now, 4)).toBeNull();
    expect(parseDueInput("soon", now, 4)).toBeNull();
  });
});

describe("presets", () => {
  it("sub-decks inherit the nearest ancestor's preset (case-insensitive)", () => {
    const presets = { default: defaultPreset(), p1: { ...defaultPreset(), id: "p1" } };
    const assign = { ortho: "p1" };
    expect(presetIdFor("Ortho/Knee", assign, presets)).toBe("p1");
    expect(presetIdFor("Step3", assign, presets)).toBe("default");
    expect(presetIdFor("Ortho/Knee", { ortho: "gone" }, presets)).toBe("default");
  });

  it("per-deck limits apply when studying the parent deck", () => {
    const note = (deck: string, n: number, base: number) =>
      refsForNote(`${deck}/N.md`, deck, parseNote(Array.from({ length: n }, (_, i) => `F${base + i} ==a${base + i}==`).join("\n\n")), base);
    const items: QueueItem[] = [...note("Ortho/Knee", 10, 0), ...note("Ortho/Hand", 10, 10)].map((ref) => ({ ref }));
    const q = buildQueue(items, new Date("2026-09-27T12:00:00Z"), DEFAULT_QUEUE, (d) =>
      d === "Ortho/Hand" ? { newPerDay: 3, reviewsPerDay: 200 } : { newPerDay: 20, reviewsPerDay: 200 },
    );
    expect(q.fresh.filter((i) => i.ref.deck === "Ortho/Hand")).toHaveLength(3);
    expect(q.fresh.filter((i) => i.ref.deck === "Ortho/Knee")).toHaveLength(10);
  });
});

describe("search", () => {
  const refs = [
    ...refsForNote("Ortho/Knee/ACL.md", "Ortho/Knee", parseNote(fixture("Ortho/Knee/ACL.md")), 0),
    ...refsForNote("Ortho/Elbow/Elbow.md", "Ortho/Elbow", parseNote(fixture("Ortho/Elbow/Elbow.md")), 100),
  ];
  const key = refs.find((r) => r.key)!.key!; // the Elbow card with ^fc-a1b2c3d4
  const events: LogEvent[] = [
    { ts: "2026-09-01T10:00:00.000Z", type: "review", key, rating: "good", ms: 1, hash: "0", device: "m" },
    { ts: "2026-09-01T10:10:00.000Z", type: "review", key, rating: "good", ms: 1, hash: "0", device: "m" },
    { ts: "2026-09-01T10:11:00.000Z", type: "flag", key, flag: 2, device: "m" },
  ];
  const states = replay(events, opts);
  const items = refs.map((ref) => ({ ref, state: ref.key ? states.get(ref.key) : undefined }));
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  const run = (q: string) => items.filter(compileSearch(q, now, 4)).map((i) => i.ref);

  it("tokenises quotes and negation", () => {
    expect(tokenize('deck:"Ortho Knee" -is:new ACL')).toEqual(["deck:Ortho Knee", "-is:new", "ACL"]);
  });

  it("filters by deck, text, tag, state, flag and props", () => {
    expect(run("deck:Ortho/Knee").every((r) => r.deck === "Ortho/Knee")).toBe(true);
    expect(run("lachman")).toHaveLength(2); // both directions
    expect(run("tag:high-yield")).toHaveLength(1);
    expect(run("-is:new").map((r) => r.key)).toEqual([key]);
    expect(run("is:review flag:2 prop:ivl>=1")).toHaveLength(1);
    expect(run("is:due")).toHaveLength(1); // due long before "now"
    expect(run("prop:lapses>0")).toHaveLength(0);
    expect(run("note:elbow deck:ortho")).toHaveLength(6);
  });

  it("finds cards by when they were answered (heatmap clicks)", () => {
    // Reviewed 2026-09-01; "now" is 2026-09-27, 26 days later.
    expect(run("rated:1")).toHaveLength(0);
    expect(run("rated:27")).toHaveLength(1);
    expect(run("prop:rated=-26")).toHaveLength(1);
    expect(run("prop:rated=-25")).toHaveLength(0);
  });
});

describe("migration from obsidian-spaced-repetition", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");
  let n = 0;
  const newId = () => `m${String(n++).padStart(7, "0")}`;

  it("parses SM-2 and FSRS SR comments", () => {
    const [a, b] = parseSrComment("!2026-10-01,12,250!2026-10-05,3,130", 4);
    expect(a.due.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(srToFsrs(a)).toMatchObject({ stability: 12 });
    expect(srToFsrs(b).difficulty).toBe(10);
    const [c] = parseSrComment("!fsrs,2026-10-01T04:00:00.000Z,12,15.2,4.1,2,5,0,0,2026-09-19T04:00:00.000Z", 4);
    expect(srToFsrs(c)).toMatchObject({ stability: 15.2, difficulty: 4.1 });
  });

  it("imports schedules, removes SR comments and adds IDs", () => {
    const r = migrateNote(fixture("Misc/SR-format.md"), { now, dayStartHour: 4, newId });
    expect(r.cards).toBe(2);
    expect(r.scheduled).toBe(2);
    expect(r.text).not.toContain("<!--SR:");
    const cards = parseNote(r.text);
    expect(cards.every((c) => c.id)).toBe(true);
    expect(cards[1].answer).toBe("Axillary");
    const states = replay(r.events.map((e) => ({ ...e, device: "mac" })), opts);
    const s = states.get(`${cards[0].id}.${cards[0].slots[0]}`)!;
    expect(s.card.state).toBe(State.Review);
    expect(s.card.due.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    // Running it again changes nothing.
    const again = migrateNote(r.text, { now, dayStartHour: 4, newId });
    expect(again.text).toBe(r.text);
    expect(again.events).toHaveLength(0);
  });

  it("imports each card of a list of one-line question cards, with no blank line between them", () => {
    const text = "#flashcards\n\nFirst-line in HFrEF::ACE inhibitor <!--SR:!2026-10-20,12,250-->\nLoop diuretic:::Furosemide <!--SR:!2026-10-12,3,230!2026-10-15,6,250-->\nNot reviewed yet::nothing";
    const r = migrateNote(text, { now, dayStartHour: 4, newId });
    expect(r.manual).toHaveLength(0);
    expect(r.text).not.toContain("<!--SR:");
    expect(r.events.map((e) => (e.type === "import" ? e.due.slice(0, 10) : ""))).toEqual(["2026-10-12", "2026-10-15", "2026-10-20"]);
    const cards = parseNote(r.text);
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => !!c.id)).toEqual([true, true, false]);
  });

  it("maps cloze siblings to their SR segments in order", () => {
    const r = migrateNote("#flashcards\n\nThe ==radial== and ==ulnar== arteries.\n<!--SR:!2026-10-01,10,250!2026-10-09,30,270-->", { now, dayStartHour: 4, newId });
    expect(r.events.map((e) => (e.type === "import" ? e.due.slice(0, 10) : ""))).toEqual(["2026-10-01", "2026-10-09"]);
  });

  it("converts one-line SR ? cards and flags multi-line fronts", () => {
    const r = migrateNote(
      "#flashcards\n\nMost common carpal fracture?\n?\nScaphoid\n\nLine one of a front\nline two\n?\nAnswer",
      { now, dayStartHour: 4, newId },
    );
    expect(r.converted).toBe(1);
    expect(r.manual).toHaveLength(1);
    const cards = parseNote(r.text);
    expect(cardFaces(cards[0], "fwd")).toMatchObject({ question: "Most common carpal fracture?", answer: "Scaphoid" });
  });

  it("lists overstuffed clozes for rewriting", () => {
    const r = migrateNote(
      "#flashcards\n\nThe ACL ==originates on the posteromedial aspect of the lateral femoral condyle behind the ridge==.",
      { now, dayStartHour: 4, newId },
    );
    expect(r.rewrite).toHaveLength(1);
    expect(r.rewrite[0].reason).toMatch(/inside the cloze/);
  });
});

import { composeCardSource } from "../src/core/ids";

describe("composeCardSource (AI split suggestions)", () => {
  it("keeps the ID at the end of a paragraph card and re-parses to the same ID", () => {
    const card = parseNote("The ACL ==originates on the medial wall of the lateral femoral condyle behind the ridge==. ^fc-aaaaaaaa")[0];
    const src = composeCardSource(card, "The ACL originates on the ==lateral femoral condyle==.", ["Medial wall, behind the resident's ridge."]);
    expect(src).toBe("The ACL originates on the ==lateral femoral condyle==.\nMedial wall, behind the resident's ridge. ^fc-aaaaaaaa");
    const again = parseNote(src)[0];
    expect(again.id).toBe("aaaaaaaa");
    expect(again.back).toBe("Medial wall, behind the resident's ridge.");
  });

  it("keeps bullet form with the ID on the bullet line", () => {
    const card = parseNote("  - Long ==cloze with lots of explanation inside it here== ^fc-bbbbbbbb")[0];
    const src = composeCardSource(card, "Short ==fact==.", ["Detail one.", "Detail two."]);
    expect(src).toBe("  - Short ==fact==. ^fc-bbbbbbbb\n      - Detail one.\n      - Detail two.");
    const again = parseNote(src)[0];
    expect(again.id).toBe("bbbbbbbb");
    expect(again.back).toBe("- Detail one.\n- Detail two.");
  });
});

describe("one by one (crown cards)", () => {
  it("turns on when a card asks for enough answers", () => {
    const [multi, single] = parseNote("Boundaries: {{c1::coracoid}}, {{c1::supraspinatus}}, {{c1::subscapularis}}\n\nThe ACL is ==intra-articular==.");
    expect(revealsOneByOne(multi, "c1", 2)).toBe(true);
    expect(revealsOneByOne(multi, "c1", 4)).toBe(false);
    expect(revealsOneByOne(multi, "c1", 0)).toBe(false);
    expect(revealsOneByOne(single, single.slots[0], 2)).toBe(false);
  });
});


describe("crowns for lists inside one cloze (0.19.0)", () => {
  const mcl = parseNote(
    "<u>Components</u> of the **MCL** <br> {{c1::Anterior oblique ligament <br> Posterior oblique ligament (posterior bundle) <br> Transverse ligament::3}}\n![[x.webp]]",
  )[0];
  it("a line-by-line list in one cloze is a crown card, one crown per line", () => {
    expect(revealsOneByOne(mcl, "c1", 2)).toBe(true);
    const f = cardFaces(mcl, "c1", crownSplit(mcl, "c1", 2));
    expect(f.answer.match(/<mark class="fc-answer">/g)).toHaveLength(3);
    expect(f.answer).toContain('<mark class="fc-answer">Posterior oblique ligament (posterior bundle)</mark> <br> ');
  });
  it("leading/trailing and doubled line breaks don't make empty crowns", () => {
    const c = parseNote("Roots {{c1:: <br> L2-L4 <br><br> Lumbosacral plexus <br> }}")[0];
    const { items } = answerItems(c.clozes[0].answer, "lines");
    expect(items).toEqual(["L2-L4", "Lumbosacral plexus"]);
  });
  it("comma lists only split when the card is switched on by hand", () => {
    const c = parseNote("Position {{c1::flexion, adduction, and internal rotation}}")[0];
    expect(revealsOneByOne(c, "c1", 2)).toBe(false);
    expect(revealsOneByOne(c, "c1", 2, true)).toBe(true);
    expect(answerItems(c.clozes[0].answer, "lists").items).toEqual(["flexion", "adduction", "internal rotation"]);
    const f = cardFaces(c, "c1", crownSplit(c, "c1", 2, true));
    expect(f.answer).toBe('Position <mark class="fc-answer">flexion</mark>, <mark class="fc-answer">adduction</mark>, and <mark class="fc-answer">internal rotation</mark>');
    // Commas inside brackets stay together.
    expect(answerItems("EDC and EPL (C7, C8)", "lists").items).toEqual(["EDC", "EPL (C7, C8)"]);
  });
  it("switched off by hand = all at once", () => {
    expect(revealsOneByOne(mcl, "c1", 2, false)).toBe(false);
    expect(crownSplit(mcl, "c1", 2, false)).toBe("none");
  });
  it("U undoes, alongside Cmd/Ctrl+Z, including for settings saved before 0.19", () => {
    expect(DEFAULT_KEYS.undo).toEqual(["Mod+z", "u"]);
    expect(mergeSettings({ keys: { undo: ["Mod+z"] } } as never).keys.undo).toEqual(["Mod+z", "u"]);
    expect(mergeSettings({ keys: { undo: ["Mod+y"] } } as never).keys.undo).toEqual(["Mod+y"]);
  });
});

describe("crown search terms (0.19.2)", () => {
  const cards = parseNote("A {{c1::x <br> y}}\n\nB {{c1::z}}\n\nC {{c1::p, q}}");
  const refs = refsForNote("n.md", "d", cards, 0);
  const status: Record<string, "on" | "off" | "auto" | "none"> = { [refs[0].uid]: "auto", [refs[1].uid]: "none", [refs[2].uid]: "on" };
  const items = refs.map((ref) => ({ ref }));
  const run = (q: string) => items.filter(compileSearch(q, 0, 4, { crown: (r) => status[r.uid] })).map((i) => i.ref.card.front[0]);
  it("is:crown = crowned by the rule or by hand; crown:on/off/auto pick one", () => {
    expect(run("is:crown")).toEqual(["A", "C"]);
    expect(run("-is:crown")).toEqual(["B"]);
    expect(run("crown:on")).toEqual(["C"]);
    expect(run("crown:auto")).toEqual(["A"]);
  });
});

describe("leeches screen (0.19.4)", () => {
  const item = (key: string, lapses: number, deck = "d") => ({ ref: { key, deck }, state: { card: { lapses } } });
  it("lists cards at the threshold, most lapses first, and hides dealt-with ones until they lapse again", () => {
    const items = [item("a", 2), item("b", 3), item("c", 6), item("d", 9, "off")];
    const t = (deck: string) => (deck === "off" ? 0 : 3);
    expect(findLeeches(items, t, {}).map((i) => i.ref.key)).toEqual(["c", "b"]);
    expect(findLeeches(items, t, { b: 3 }).map((i) => i.ref.key)).toEqual(["c"]);
    expect(findLeeches([item("b", 5)], t, { b: 3 }).map((i) => i.ref.key)).toEqual(["b"]);
  });
});

describe("& lists crown too (0.19.6)", () => {
  const items = (a: string) => answerItems(a, "lines").items;
  it("splits A & B and A, B, & C, but not a shared-noun name", () => {
    expect(items("**Vertical translation in the coronal plane** & **Flexion/extension in the saggital plane**")).toEqual([
      "**Vertical translation in the coronal plane**",
      "**Flexion/extension in the saggital plane**",
    ]);
    expect(items("McMurray's, Apley's, & Thessaly's")).toEqual(["McMurray's", "Apley's", "Thessaly's"]);
    expect(items("PT &amp; PQ")).toEqual(["PT", "PQ"]);
    expect(items("Lewis & Rorabeck classification")).toHaveLength(1);
    expect(items("Broden's views (leg rotated, beam 10-40° cephalad) & Harris (Axial)")).toEqual(["Broden's views (leg rotated, beam 10-40° cephalad)", "Harris (Axial)"]);
    expect(items("flexion, adduction, and internal rotation")).toHaveLength(1);
  });
});
describe("& lists: a first piece with its own aside stands alone", () => {
  it("splits approach pairs", () => {
    expect(answerItems("**anterolateral** (Watson-Jones) & **direct lateral** (Hardinge)", "lines").items).toHaveLength(2);
  });
});

describe("download check (0.21.0)", () => {
  it("counts reads that fail or never finish as missing, without waiting on them", async () => {
    const { probeDownloads, samplePaths } = await import("../src/plugin/downloads");
    const read = (p: string) => (p === "ok.png" ? Promise.resolve(new ArrayBuffer(1)) : p === "gone.png" ? Promise.reject(new Error("x")) : new Promise(() => undefined));
    const t0 = Date.now();
    expect(await probeDownloads(read, ["ok.png", "gone.png", "offloaded.png"], 40)).toEqual({ checked: 3, missing: 2 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await probeDownloads(read, ["ok.png"], 40)).toEqual({ checked: 1, missing: 0 });
    const picked = samplePaths(["a", "b", "c", "d"], 3, () => 0);
    expect(picked).toEqual(["a", "b", "c"]);
    expect(samplePaths(["a"], 5)).toEqual(["a"]);
  });
});

describe("synced API key file (0.24.0)", () => {
  it("round-trips the key and treats a broken file as no key", async () => {
    const { formatKeyFile, parseKeyFile, keyFilePath } = await import("../src/plugin/secrets");
    expect(parseKeyFile(formatKeyFile("sk-ant-abc"))).toBe("sk-ant-abc");
    expect(parseKeyFile('{"anthropicKey": "  sk-ant-x \\n"}')).toBe("sk-ant-x");
    expect(parseKeyFile('{"anthropicKey": "sk-a')).toBe("");
    expect(parseKeyFile("{}")).toBe("");
    expect(keyFilePath(".obsidian/plugins/flashcards")).toBe(".obsidian/plugins/flashcards/api-key.json");
  });
});

import { aiKeyId, chatBody, chatJson, chatUrl } from "../src/core/ai-providers";

describe("AI providers", () => {
  it("keeps Anthropic's key where it always was and gives each other provider its own", () => {
    expect(aiKeyId("anthropic")).toBe("flashcards-anthropic-key");
    expect(aiKeyId("openai")).toBe("flashcards-ai-key-openai");
  });
  it("builds the chat URL from the provider or the typed address", () => {
    expect(chatUrl("openai", "")).toBe("https://api.openai.com/v1/chat/completions");
    expect(chatUrl("custom", " http://localhost:11434/v1/ ")).toBe("http://localhost:11434/v1/chat/completions");
    expect(chatUrl("custom", "https://x.test/v1/chat/completions")).toBe("https://x.test/v1/chat/completions");
    expect(chatUrl("custom", "")).toBe("");
  });
  it("asks for one JSON object that fits the schema", () => {
    const b = chatBody("m", "sys", "user text", { type: "object" }) as { messages: Array<{ role: string; content: string }>; response_format: unknown };
    expect(b.messages[0].content).toContain('{"type":"object"}');
    expect(b.messages[1]).toEqual({ role: "user", content: "user text" });
    expect(b.response_format).toEqual({ type: "json_object" });
  });
  it("reads the JSON out of a reply, fenced or not, and reports cut-off or declined replies", () => {
    const reply = (content: string, finish = "stop") => ({ choices: [{ message: { content }, finish_reason: finish }] });
    expect(chatJson(reply('{"a":1}'))).toEqual({ a: 1 });
    expect(chatJson(reply('```json\n{"a":[1,2]}\n```'))).toEqual({ a: [1, 2] });
    expect(() => chatJson(reply('{"a":', "length"))).toThrow(/cut off/);
    expect(() => chatJson(reply("sorry"))).toThrow(/couldn't be read/);
    expect(() => chatJson({ choices: [{ message: { refusal: "no" } }] })).toThrow(/declined/);
    expect(() => chatJson({})).toThrow(/couldn't be read/);
  });
});

import { matchNotes } from "../src/core/note-match";

describe("finding a student's notes about a card by title words", () => {
  const notes = [
    { path: "Trauma/Pelvic Ring and Acetabular Fracture.md", names: ["Pelvic Ring and Acetabular Fracture", "Lateral compression injury", "Open book pelvis", "Vertical shear"] },
    { path: "Approaches/Pelvis and Acetabulum Approaches.md", names: ["Pelvis and Acetabulum Approaches"] },
    ...["Distal Radius", "Scaphoid", "Clavicle", "Femoral Neck", "Tibial Plateau", "Ankle", "Calcaneus", "Talus"].map((b) => ({ path: `Trauma/${b} Fracture.md`, names: [`${b} Fracture`] })),
    { path: "Knee/ACL.md", names: ["ACL", "Anterior cruciate ligament"] },
  ];
  it("matches on a distinctive word even when the wording differs", () => {
    const got = matchNotes('The "spur sign" on the obturator oblique view is pathognomonic for a both column acetabular fracture', notes);
    expect(got).toEqual(["Trauma/Pelvic Ring and Acetabular Fracture.md"]);
    expect(got).not.toContain("Trauma/Scaphoid Fracture.md");
  });
  it("does not match on a word most titles share, and uses aliases", () => {
    expect(matchNotes("A fracture that heals slowly", notes)).toEqual([]);
    expect(matchNotes("The anterior cruciate ligament resists translation", notes)).toEqual(["Knee/ACL.md"]);
  });
});
