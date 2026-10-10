/**
 * Anki collection → notes, media and log events (spec 0006 §2–§4). Pure.
 */
import { cyrb53 } from "../hash";
import type { LogEvent, RatingName } from "../log";
import { srToFsrs } from "../migrate";
import { newMaskId, serializeOcclusion, type Mask, type Occlusion } from "../occlusion";
import { parseNote } from "../parser";
import { decodeEntities, escapeCardText, htmlToMarkdown, safeDecode } from "./html";
import { parseIoeId, parseIoeSvg } from "./ioe";
import type { AnkiCard, AnkiCollection, AnkiNote, AnkiNotetype } from "./package";

export interface ConvertOptions {
  /** Vault folder for imported decks, e.g. "Anki". */
  root: string;
  keepTags: boolean;
  includeScheduling: boolean;
  /** Anki note GUIDs already imported (skipped, unless in `updateIds`). */
  skipGuids: Set<string>;
  /**
   * "Update by re-import" (spec 0006 §updates): already-imported GUID → its card ID. These notes are
   * rebuilt with their existing ID and returned in `updates` (never as new files or history), so the
   * vault card can be rewritten in place and keep its review history.
   */
  updateIds?: Map<string, string>;
  newId: () => string;
  now: Date;
  /** Pixel size of an image (for occlusion shapes stored in pixels). */
  imageSize?: (filename: string) => { width: number; height: number } | null;
  pathExists?: (path: string) => boolean;
  /** Text of a media file (the old Image Occlusion Enhanced add-on keeps its boxes in SVGs). */
  readText?: (filename: string) => string | null;
  random?: () => number;
  notesPerFile?: number;
}

export interface ConvertResult {
  /** `ids`/`guids`: the cards in each file, so a failed write can be left out of the log. */
  /** `hubs`: each note's AnkiHub ID ("" if none), which link tables can match on (spec 0011). */
  files: Array<{ path: string; deck: string; content: string; notes: number; ids: string[]; guids: string[]; hubs: string[] }>;
  /** Anki media filename → vault path to write it to. */
  media: Map<string, string>;
  events: LogEvent[];
  guids: Array<{ guid: string; id: string }>;
  /** Rebuilt source lines for already-imported notes (see `updateIds`). */
  updates: Array<{ guid: string; id: string; lines: string[] }>;
  stats: { notes: number; cards: number; skipped: number; empty: number; occlusion: number; withHistory: number; unsupported: number };
}

const RATING: Record<number, RatingName> = { 1: "again", 2: "hard", 3: "good", 4: "easy" };

function safePathPart(s: string): string {
  // "#OrthoKing" → "OrthoKing": a replaced leading character would leave a stray "-".
  const t = s.replace(/[\\/:*?"<>|#^[\]]+/g, "-").replace(/\s+/g, " ").trim().replace(/^[.-]+|-+$/g, "").slice(0, 100).trim();
  return t || "Untitled";
}

function tagPart(s: string): string {
  let t = s.normalize("NFC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!t) t = "deck";
  if (/^\d+$/.test(t)) t = `d${t}`;
  return t;
}

/**
 * The vault name for a media file. Obsidian's normalizePath turns no-break spaces (macOS
 * screenshot names have U+202F before "AM"/"PM") into plain spaces and applies NFC when it
 * writes the file, so the link must use the same name or it points at nothing.
 */
export function safeMediaName(s: string): string {
  return s.replace(/[\\/:*?"<>|#^[\]]+/g, "-").replace(/[  ]/g, " ").normalize("NFC");
}

/** Every media filename a note refers to (images and sounds). */
export function mediaInFields(fields: string[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    for (const m of f.matchAll(/<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const src = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
      if (src && !/^(https?:|data:)/i.test(src)) out.push(safeDecode(src.split("?")[0]));
    }
    for (const m of f.matchAll(/\[sound:([^\]]+)\]/g)) out.push(m[1].trim());
  }
  return out;
}

export function referencedMedia(col: AnkiCollection): Set<string> {
  const set = new Set<string>();
  for (const n of col.notes) for (const f of mediaInFields(n.fields)) set.add(f);
  return set;
}

interface Block {
  deck: string;
  lines: string[];
  note: AnkiNote;
  id: string;
  /** Anki card ord → our slot. */
  slotForOrd: (ord: number) => string | undefined;
  /** Several Anki notes in one block (Image Occlusion Enhanced: one note per box). */
  members?: Array<{ note: AnkiNote; slot: string }>;
}

/** The notes of a block with their card → slot mapping. */
function blockNotes(b: Block): Array<{ note: AnkiNote; slotForOrd: (ord: number) => string | undefined }> {
  return b.members ? b.members.map((m) => ({ note: m.note, slotForOrd: () => m.slot })) : [{ note: b.note, slotForOrd: b.slotForOrd }];
}

/** Is this note type the old Image Occlusion Enhanced add-on's? */
export function isIoeNotetype(nt: AnkiNotetype): boolean {
  return nt.fields.some((x) => /^original mask$/i.test(x)) && nt.fields.some((x) => /^question mask$/i.test(x));
}

export function convertCollection(col: AnkiCollection, o: ConvertOptions): ConvertResult {
  const stats = { notes: 0, cards: 0, skipped: 0, empty: 0, occlusion: 0, withHistory: 0, unsupported: 0 };
  const media = new Map<string, string>();
  const events: LogEvent[] = [];
  const guids: Array<{ guid: string; id: string }> = [];
  const cardsByNote = new Map<number, AnkiCard[]>();
  for (const c of col.cards) {
    const l = cardsByNote.get(c.nid);
    if (l) l.push(c);
    else cardsByNote.set(c.nid, [c]);
  }
  const revlogByCard = new Map<number, typeof col.revlog>();
  for (const r of col.revlog) {
    const l = revlogByCard.get(r.cid);
    if (l) l.push(r);
    else revlogByCard.set(r.cid, [r]);
  }
  // One media folder for the whole import: a picture shared by two decks is written once.
  const mediaDir = `${o.root}/media`;
  const resolve = (f: string) => {
    const p = `${mediaDir}/${safeMediaName(f)}`;
    media.set(f, p);
    return p;
  };

  const blocks: Block[] = [];
  const updates: Array<{ guid: string; id: string; lines: string[] }> = [];
  const ioe = new Map<string, Array<{ note: AnkiNote; nt: AnkiNotetype; deck: string }>>();
  for (const note of col.notes) {
    const cards = cardsByNote.get(note.id) ?? [];
    if (!cards.length) continue;
    const updateId = o.updateIds?.get(note.guid);
    const nt = col.notetypes.get(note.mid);
    if (updateId && nt && !isIoeNotetype(nt)) {
      const block = buildBlock(note, nt, updateId, resolve, o);
      if (block) updates.push({ guid: note.guid, id: updateId, lines: block.lines });
      stats.skipped++;
      continue;
    }
    if (o.skipGuids.has(note.guid) || updateId) {
      stats.skipped++;
      continue;
    }
    const deck = col.decks.get(cards[0].did) ?? "Default";
    if (nt && isIoeNotetype(nt)) {
      const info = parseIoeId(stripHtml(note.fields[0] ?? ""));
      if (!info) {
        stats.empty++;
        continue;
      }
      const k = `${info.figure}|${info.hideAll}`;
      ioe.set(k, [...(ioe.get(k) ?? []), { note, nt, deck }]);
      continue;
    }
    const id = o.newId();
    const block = nt ? buildBlock(note, nt, id, resolve, o) : null;
    if (!block) {
      stats[nt ? "empty" : "unsupported"]++;
      continue;
    }
    if (block.occlusion) stats.occlusion++;
    blocks.push({ deck, lines: block.lines, note, id, slotForOrd: block.slotForOrd });
  }

  for (const group of ioe.values()) {
    const b = buildIoeBlock(group, o.newId(), resolve, o);
    if (!b) {
      stats.empty += group.length;
      continue;
    }
    stats.empty += group.length - b.members!.length;
    stats.occlusion++;
    blocks.push(b);
  }

  // Scheduling: review history → review events; otherwise a seed from interval and ease.
  let tick = 0;
  const nowTs = () => new Date(o.now.getTime() + tick++).toISOString();
  const good: Block[] = [];
  for (const b of blocks) {
    // Safety net: the block must read back as exactly one card carrying its ID, or its history
    // would be logged against an ID no card has.
    const all = parseNote(b.lines.join("\n"));
    const parsed = all[0];
    if (all.length !== 1 || parsed.id !== b.id) {
      stats.unsupported++;
      continue;
    }
    good.push(b);
    const slots = new Set(parsed.slots);
    const hash = parsed.hash;
    for (const { note, slotForOrd } of blockNotes(b)) {
    guids.push({ guid: note.guid, id: b.id });
    stats.notes++;
    for (const c of cardsByNote.get(note.id) ?? []) {
      const slot = slotForOrd(c.ord);
      if (!slot || !slots.has(slot)) continue;
      stats.cards++;
      if (!o.includeScheduling) continue;
      const key = `${b.id}.${slot}`;
      const log = revlogByCard.get(c.id) ?? [];
      const reviews = log.filter((r) => r.ease >= 1 && r.ease <= 4 && r.type <= 3);
      if (reviews.length) {
        stats.withHistory++;
        for (const r of log) {
          const ts = new Date(r.id).toISOString();
          if (r.ease >= 1 && r.ease <= 4 && r.type <= 3) {
            events.push({ ts, type: "review", key, rating: RATING[r.ease], ms: Math.min(Math.max(r.time, 0), 60000), hash });
          } else if (r.ease === 0 && r.type >= 4 && r.ivl === 0) {
            // "Forget" in Anki: earlier answers no longer count.
            events.push({ ts, type: "reset", key });
          }
        }
      } else if (c.type === 2 && c.ivl > 0) {
        stats.withHistory++;
        const due = new Date((col.crt + c.due * 86400) * 1000);
        const f = srToFsrs({ due, intervalDays: c.ivl, ease: c.factor > 0 ? c.factor / 10 : 250 });
        events.push({ ts: nowTs(), type: "import", key, due: due.toISOString(), stability: f.stability, difficulty: f.difficulty, lastReview: f.lastReview.toISOString() });
      }
      if (c.queue === -1) events.push({ ts: nowTs(), type: "suspend", key });
      if (c.flags & 7) events.push({ ts: nowTs(), type: "flag", key, flag: c.flags & 7 });
    }
    }
  }

  // One note per deck, split into files of `notesPerFile`.
  const perFile = o.notesPerFile ?? 300;
  const byDeck = new Map<string, Block[]>();
  for (const b of good) {
    const l = byDeck.get(b.deck);
    if (l) l.push(b);
    else byDeck.set(b.deck, [b]);
  }
  const files: ConvertResult["files"] = [];
  // Mac and iPhone file systems ignore case: "Cardio.md" and "cardio.md" are the same file.
  const taken = new Set<string>();
  for (const [deck, list] of byDeck) {
    const parts = deck.split("::");
    const folder = [o.root, ...parts.slice(0, parts.length === 1 ? 1 : -1).map(safePathPart)].join("/");
    const base = safePathPart(parts[parts.length - 1]);
    const tag = `flashcards/${parts.map(tagPart).join("/")}`;
    for (let i = 0, part = 1; i < list.length; i += perFile, part++) {
      let path = `${folder}/${base}${part > 1 ? ` ${part}` : ""}.md`;
      for (let n = 2; taken.has(path.toLowerCase()) || o.pathExists?.(path); n++) path = `${folder}/${base} (import ${n}).md`;
      taken.add(path.toLowerCase());
      const chunk = list.slice(i, i + perFile);
      const content = [
        "---",
        `tags: [${tag}]`,
        `anki-deck: ${JSON.stringify(deck)}`,
        "---",
        "",
        `# ${parts[parts.length - 1]}`,
        "",
        chunk.map((b) => b.lines.join("\n")).join("\n\n"),
        "",
      ].join("\n");
      // One entry per Anki note (an occlusion block can hold several), parallel arrays.
      const pairs = chunk.flatMap((b) => blockNotes(b).map(({ note }) => ({ id: b.id, guid: note.guid, hub: ankihubId(note, col.notetypes.get(note.mid)) })));
      files.push({ path, deck, content, notes: chunk.length, ids: pairs.map((p) => p.id), guids: pairs.map((p) => p.guid), hubs: pairs.map((p) => p.hub) });
    }
  }
  return { files, media, events, guids, updates, stats };
}

/** The note's AnkiHub ID (its `ankihub_id` field, a UUID), or "". */
export function ankihubId(note: AnkiNote, nt: AnkiNotetype | undefined): string {
  const i = nt ? nt.fields.findIndex((f) => /^ankihub_id$/i.test(f.trim())) : -1;
  const v = i >= 0 ? stripHtml(note.fields[i] ?? "").trim() : "";
  return /^[0-9a-f-]{36}$/i.test(v) ? v.toLowerCase() : "";
}

/**
 * Fields Anki templates use for machinery, not for reading: AnkiHub's sync ID, the "One by one"
 * add-on's switch, and bare numbers (e.g. an AnKing "Lecture Notes" index like "9").
 */
export function isHiddenField(name: string, html: string): boolean {
  if (/^(ankihub_id|one by one|guid|note id)$/i.test(name.trim())) return true;
  const text = decodeEntities(html.replace(/<[^>]*>/g, "")).trim();
  return /^\d+$/.test(text) && !/<img\b/i.test(html);
}

function fieldIndex(nt: AnkiNotetype, names: string[], fallback: number): number {
  const i = nt.fields.findIndex((f) => names.some((n) => f.toLowerCase() === n.toLowerCase()));
  return i >= 0 ? i : fallback;
}

function toLines(html: string, resolve: (f: string) => string): string[] {
  return htmlToMarkdown(html, resolve).split("\n").filter((l) => l.trim());
}

function buildBlock(
  note: AnkiNote,
  nt: AnkiNotetype,
  id: string,
  resolve: (f: string) => string,
  o: ConvertOptions,
): { lines: string[]; slotForOrd: (ord: number) => string | undefined; occlusion?: boolean } | null {
  const f = note.fields;
  if (f.some((x) => x.includes("image-occlusion:"))) return buildOcclusion(note, nt, id, resolve, o);
  // The old "Image Occlusion Enhanced" add-on is converted per figure in convertCollection.
  if (nt.fields.some((x) => /^(question mask|original mask)$/i.test(x))) return null;

  const tags = o.keepTags && note.tags.length ? " " + note.tags.map((t) => `#${t.replace(/::/g, "/").replace(/[^\p{L}\p{N}_/-]+/gu, "_")}`).join(" ") : "";
  const clozeIdx = f.findIndex((x) => /\{\{c\d+::/.test(x));
  const isCloze = nt.kind === "cloze" || clozeIdx >= 0;
  // The back, as Anki shows it: Extra first and unlabelled, then the other fields with their
  // names. Machine fields (AnkiHub's ID, add-on helpers, bare numbers) are left out.
  const backFrom = (skip: Set<number>): string[] => {
    const plain: string[] = [];
    const labelled: string[] = [];
    f.forEach((val, i) => {
      if (skip.has(i)) return;
      const name = nt.fields[i] ?? `Field ${i + 1}`;
      if (isHiddenField(name, val)) return;
      const lines = toLines(val, resolve).map((l) => escapeCardText(l, { keepAnkiCloze: false }));
      if (!lines.length) return;
      if (/^(back extra|extra|back)$/i.test(name)) plain.push(...lines);
      else labelled.push(`**${name}:** ${lines[0]}`, ...lines.slice(1));
    });
    return [...plain, ...labelled];
  };

  if (isCloze) {
    const idx = clozeIdx >= 0 ? clozeIdx : 0;
    // Join first, then escape: a cloze can itself contain a line break ({{c1::a<br>b}}).
    const text = escapeCardText(toLines(f[idx], resolve).join(" <br> "), { keepAnkiCloze: true, front: true });
    if (!/\{\{c\d+::/.test(text)) return null;
    const back = backFrom(new Set([idx]));
    const lines = [text + tags, ...back];
    lines[lines.length - 1] += ` ^fc-${id}`;
    return { lines, slotForOrd: (ord) => `c${ord + 1}` };
  }

  const front = escapeCardText(toLines(f[0] ?? "", resolve).join(" <br> "), { keepAnkiCloze: false, front: true });
  if (!front) return null;
  const optional = /optional/i.test(nt.name);
  const answer = toLines(f[1] ?? "", resolve).map((l) => escapeCardText(l, { keepAnkiCloze: false }));
  // A reverse card needs an answer to ask about.
  const reversed = answer.length > 0 && nt.templates >= 2 && (!optional || !!(f[2] ?? "").replace(/<[^>]*>/g, "").trim());
  const skip = new Set([0, 1]);
  if (optional) skip.add(2);
  const others = backFrom(skip);
  const lines = [`${front}${tags} ${reversed ? ":::" : "::"}`, ...answer, ...others];
  lines[lines.length - 1] += ` ^fc-${id}`;
  return { lines, slotForOrd: (ord) => (ord === 0 ? "fwd" : ord === 1 && reversed ? "rev" : undefined) };
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).trim();
}

function imgSrc(html: string): string {
  const src = /<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html ?? "");
  return src ? safeDecode(decodeEntities(src[2] ?? src[3] ?? src[4] ?? "").split("?")[0]) : "";
}

/**
 * Old Image Occlusion Enhanced notes of one figure → one fc-occlusion block. The boxes come from
 * the "original mask" SVG; each Anki note's card becomes the slot of its box.
 */
function buildIoeBlock(
  group: Array<{ note: AnkiNote; nt: AnkiNotetype; deck: string }>,
  id: string,
  resolve: (f: string) => string,
  o: ConvertOptions,
): Block | null {
  const { note: first, nt, deck } = group[0];
  const idx = (names: string[], fallback: number) => fieldIndex(nt, names, fallback);
  const imageFile = imgSrc(first.fields[idx(["Image"], 2)]);
  const maskFile = imgSrc(first.fields[idx(["Original Mask"], 10)]);
  if (!imageFile || !maskFile) return null;
  const svg = o.readText?.(maskFile);
  const parsed = svg ? parseIoeSvg(svg) : null;
  if (!parsed || !parsed.boxes.size) return null;
  const hideAll = parseIoeId(stripHtml(first.fields[0]))!.hideAll;
  const occ: Occlusion = { image: resolve(imageFile), mode: hideAll ? "hide-all" : "hide-one", masks: [], groups: [], id };
  const header = toLines(first.fields[idx(["Header"], 1)] ?? "", resolve).join(" ");
  if (header) occ.header = header;
  const slotForBox = new Map<string, string>();
  const order = [...parsed.boxes.keys()].sort((a, b) => (parseIoeId(a)?.n ?? 0) - (parseIoeId(b)?.n ?? 0));
  for (const box of order) {
    const ids: string[] = [];
    for (const s of parsed.boxes.get(box)!) {
      const mid = newMaskId(occ, [], o.random);
      occ.masks.push({ id: mid, shape: s.shape, coords: s.coords });
      ids.push(mid);
    }
    if (ids.length === 1) slotForBox.set(box, ids[0]);
    else {
      const gid = newMaskId(occ, [], o.random);
      occ.groups.push({ id: gid, members: ids });
      slotForBox.set(box, gid);
    }
  }
  const members: Array<{ note: AnkiNote; slot: string }> = [];
  for (const g of group) {
    const slot = slotForBox.get(stripHtml(g.note.fields[0]));
    if (slot) members.push({ note: g.note, slot });
  }
  if (!members.length) return null;
  // The back: footer, remarks, sources and extras, each line once across the figure's notes.
  const back: string[] = [];
  const seen = new Set<string>();
  for (const g of group) {
    for (const name of ["Footer", "Remarks", "Sources", "Extra 1", "Extra 2"]) {
      const i = g.nt.fields.findIndex((f) => f.toLowerCase() === name.toLowerCase());
      if (i < 0) continue;
      for (const l of toLines(g.note.fields[i] ?? "", resolve).map((x) => escapeCardText(x, { keepAnkiCloze: false }))) {
        if (!seen.has(l)) {
          seen.add(l);
          back.push(l);
        }
      }
    }
  }
  const lines = ["```fc-occlusion", ...serializeOcclusion(occ).split("\n"), "```", ...back];
  return { deck, lines, note: first, id, slotForOrd: () => undefined, members };
}

/** Anki 23.10+ Image Occlusion notes → an fc-occlusion block (spec 0004). */
function buildOcclusion(
  note: AnkiNote,
  nt: AnkiNotetype,
  id: string,
  resolve: (f: string) => string,
  o: ConvertOptions,
): { lines: string[]; slotForOrd: (ord: number) => string | undefined; occlusion: true } | null {
  const f = note.fields;
  const occIdx = f.findIndex((x) => x.includes("image-occlusion:"));
  const imgIdx = fieldIndex(nt, ["Image"], 1);
  const headerIdx = fieldIndex(nt, ["Header"], 2);
  const extraIdx = fieldIndex(nt, ["Back Extra"], 3);
  const commentsIdx = fieldIndex(nt, ["Comments"], 4);
  const src = /<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(f[imgIdx] ?? "");
  const file = src ? safeDecode(decodeEntities(src[2] ?? src[3] ?? src[4] ?? "").split("?")[0]) : "";
  if (!file) return null;
  const image = resolve(file);

  const byN = new Map<number, Array<{ shape: Mask["shape"]; coords: number[] }>>();
  // Anki writes ":oi=1" only when "Hide all, guess one" is chosen.
  let hideAll = false;
  let pixels = false;
  for (const m of f[occIdx].matchAll(/\{\{c(\d+)::image-occlusion:(rect|ellipse|polygon):([^}]*)\}\}/g)) {
    const props = new Map<string, string>();
    for (const kv of m[3].split(":")) {
      const eq = kv.indexOf("=");
      if (eq > 0) props.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
    const n = Number(m[1]);
    if (props.get("oi") === "1") hideAll = true;
    const num = (k: string) => Number(props.get(k) ?? "NaN");
    let shape: Mask["shape"];
    let coords: number[];
    if (m[2] === "rect") {
      shape = "rect";
      coords = [num("left"), num("top"), num("width"), num("height")];
    } else if (m[2] === "ellipse") {
      shape = "ellipse";
      coords = [num("left"), num("top"), num("rx") * 2, num("ry") * 2];
    } else {
      shape = "poly";
      coords = (props.get("points") ?? "").trim().split(/[\s,]+/).map(Number);
    }
    if (coords.some((c) => !Number.isFinite(c)) || (shape === "poly" && coords.length < 6)) continue;
    if (coords.some((c) => c > 1.5)) pixels = true;
    byN.set(n, [...(byN.get(n) ?? []), { shape, coords }]);
  }
  if (!byN.size) return null;
  if (pixels) {
    const size = o.imageSize?.(file);
    if (!size) return null;
    for (const shapes of byN.values()) {
      for (const s of shapes) s.coords = s.coords.map((c, i) => c / (i % 2 === 0 ? size.width : size.height));
    }
  }
  const occ: Occlusion = { image, mode: hideAll ? "hide-all" : "hide-one", masks: [], groups: [], id };
  const header = toLines(f[headerIdx] ?? "", resolve).join(" ");
  if (header && headerIdx !== occIdx && headerIdx !== imgIdx) occ.header = header;
  const slotForN = new Map<number, string>();
  for (const [n, shapes] of [...byN].sort((a, b) => a[0] - b[0])) {
    const ids: string[] = [];
    for (const s of shapes) {
      const mid = newMaskId(occ, [], o.random);
      occ.masks.push({ id: mid, shape: s.shape, coords: s.coords.map((c) => Math.min(1, Math.max(0, c))) });
      ids.push(mid);
    }
    if (ids.length === 1) slotForN.set(n, ids[0]);
    else {
      const gid = newMaskId(occ, [], o.random);
      occ.groups.push({ id: gid, members: ids });
      slotForN.set(n, gid);
    }
  }
  const back: string[] = [];
  for (const i of [extraIdx, commentsIdx]) {
    if (i === occIdx || i === imgIdx || i === headerIdx) continue;
    back.push(...toLines(f[i] ?? "", resolve).map((l) => escapeCardText(l, { keepAnkiCloze: false })));
  }
  const lines = ["```fc-occlusion", ...serializeOcclusion(occ).split("\n"), "```", ...back];
  return { lines, slotForOrd: (ord) => slotForN.get(ord + 1), occlusion: true };
}

/** Width and height of a PNG, JPEG or GIF from its bytes (for pixel-based occlusion shapes). */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
      }
      i += 2 + len;
    }
  }
  return null;
}

/**
 * Copying pictures for a deck imported without media (spec 0006 §media): which Anki media files to copy,
 * given the vault filenames the imported cards embed (already made safe) and the names in Anki's
 * collection.media folder. Returns original → vault name pairs, and the names Anki doesn't have.
 */
export function planMediaCopy(needed: Iterable<string>, ankiNames: Iterable<string>): { copy: Array<[string, string]>; notFound: string[] } {
  const bySafe = new Map<string, string>();
  for (const n of ankiNames) if (!bySafe.has(safeMediaName(n))) bySafe.set(safeMediaName(n), n);
  const copy: Array<[string, string]> = [];
  const notFound: string[] = [];
  for (const safe of new Set(needed)) {
    const orig = bySafe.get(safe.normalize("NFC"));
    if (orig) copy.push([orig, safe]);
    else notFound.push(safe);
  }
  return { copy, notFound };
}

/** Fingerprint of a card's source as imported, to tell later whether it was edited in Obsidian. */
export function sourceHash(lines: readonly string[]): string {
  return cyrb53(normSource(lines)).toString(36);
}

function normSource(l: readonly string[]): string {
  return l.map((x) => x.trimEnd()).join("\n").trim();
}

/**
 * Apply re-import updates to one note's text: every card whose ID is in `updates` and whose source
 * differs is replaced by the rebuilt lines (same ID, so its history is kept). Returns the new text
 * and the IDs that actually changed. Cards are replaced bottom-up so line numbers stay valid.
 * With `imported` (card ID → sourceHash as last imported), a card whose text no longer matches was
 * edited in Obsidian: it is left alone and listed in `kept`.
 */
export function applyCardUpdates(
  text: string,
  updates: Map<string, string[]>,
  imported?: ReadonlyMap<string, string>,
): { text: string; changed: string[]; kept: string[] } {
  const cards = parseNote(text)
    .filter((c) => c.id && updates.has(c.id))
    .sort((a, b) => b.startLine - a.startLine);
  const lines = text.split("\n");
  const changed: string[] = [];
  const kept: string[] = [];
  for (const c of cards) {
    const next = updates.get(c.id!)!;
    if (normSource(c.sourceLines) === normSource(next)) continue;
    const was = imported?.get(c.id!);
    if (was !== undefined && was !== sourceHash(c.sourceLines)) {
      kept.push(c.id!);
      continue;
    }
    lines.splice(c.startLine, c.endLine - c.startLine + 1, ...next);
    changed.push(c.id!);
  }
  return { text: lines.join("\n"), changed: changed.reverse(), kept: kept.reverse() };
}
