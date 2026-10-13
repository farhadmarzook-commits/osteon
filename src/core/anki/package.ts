/**
 * Read an Anki package (.apkg) into plain data (spec 0006 §5). Handles the legacy format
 * (collection.anki2 / collection.anki21 + JSON media map) and the current one
 * (collection.anki21b, zstd-compressed, schema 18, protobuf media map).
 * The SQLite engine is passed in (sql.js), so this module works in tests and in the plugin.
 */
import { unzipSync } from "fflate";
import { decompress as zstdDecompress } from "fzstd";
import type { Database, SqlJsStatic } from "sql.js";

export interface AnkiNotetype {
  id: number;
  name: string;
  kind: "normal" | "cloze";
  fields: string[];
  templates: number;
}

export interface AnkiNote {
  id: number;
  guid: string;
  mid: number;
  tags: string[];
  fields: string[];
}

export interface AnkiCard {
  id: number;
  nid: number;
  did: number;
  ord: number;
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  flags: number;
}

export interface AnkiRevlog {
  id: number;
  cid: number;
  ease: number;
  ivl: number;
  time: number;
  type: number;
}

export interface AnkiCollection {
  /** Collection creation time (seconds): review due dates count days from here. */
  crt: number;
  notetypes: Map<number, AnkiNotetype>;
  /** Deck ID → full name with "::" separators. */
  decks: Map<number, string>;
  notes: AnkiNote[];
  cards: AnkiCard[];
  revlog: AnkiRevlog[];
  /** Media filename → name of its entry in the zip. */
  mediaIndex: Map<string, string>;
  format: "legacy" | "anki21b";
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function isZstd(b: Uint8Array): boolean {
  return b.length >= 4 && ZSTD_MAGIC.every((v, i) => b[i] === v);
}

export function maybeZstd(b: Uint8Array): Uint8Array {
  return isZstd(b) ? zstdDecompress(b) : b;
}

// ---- a minimal protobuf reader (for the media map and notetype config) ----------------------

function readVarint(b: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = b[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [result, pos];
    shift += 7;
  }
}

/** Iterate over the top-level fields of a protobuf message. */
export function* protoFields(b: Uint8Array): Generator<{ field: number; wire: number; value: number | Uint8Array }> {
  let pos = 0;
  while (pos < b.length) {
    let key: number;
    [key, pos] = readVarint(b, pos);
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) {
      let v: number;
      [v, pos] = readVarint(b, pos);
      yield { field, wire, value: v };
    } else if (wire === 2) {
      let len: number;
      [len, pos] = readVarint(b, pos);
      yield { field, wire, value: b.subarray(pos, pos + len) };
      pos += len;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
}

const utf8 = new TextDecoder();

/** The media map: legacy JSON {"0": "name.png"} or protobuf MediaEntries (anki21b). */
export function parseMediaMap(raw: Uint8Array): Map<string, string> {
  const b = maybeZstd(raw);
  const map = new Map<string, string>();
  const text = utf8.decode(b.subarray(0, 1));
  if (text === "{") {
    const obj = JSON.parse(utf8.decode(b)) as Record<string, string>;
    for (const [zipName, file] of Object.entries(obj)) map.set(file, zipName);
    return map;
  }
  let index = 0;
  for (const f of protoFields(b)) {
    if (f.field !== 1 || !(f.value instanceof Uint8Array)) continue;
    let name = "";
    let legacy: number | undefined;
    for (const g of protoFields(f.value)) {
      if (g.field === 1 && g.value instanceof Uint8Array) name = utf8.decode(g.value);
      if (g.field === 255 && typeof g.value === "number") legacy = g.value;
    }
    if (name) map.set(name, String(legacy ?? index));
    index++;
  }
  return map;
}

// ---- reading the collection ------------------------------------------------------------------

function rows<T>(db: Database, sql: string, map: (r: unknown[]) => T): T[] {
  const res = db.exec(sql);
  return res.length ? res[0].values.map((r) => map(r as unknown[])) : [];
}

/** A text column as a string; anything else (null, a blob) reads as empty. */
function text(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function hasTable(db: Database, name: string): boolean {
  return rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`, (r) => r[0]).length > 0;
}

function readCollection(db: Database): Omit<AnkiCollection, "mediaIndex" | "format"> {
  const notetypes = new Map<number, AnkiNotetype>();
  const decks = new Map<number, string>();
  const crt = Number(rows(db, "SELECT crt FROM col", (r) => r[0])[0] ?? 0);

  if (hasTable(db, "notetypes")) {
    // Schema 18: separate tables; notetype kind is field 1 of the protobuf config.
    for (const [id, name, config] of rows(db, "SELECT id, name, config FROM notetypes", (r) => r)) {
      let kind: "normal" | "cloze" = "normal";
      if (config instanceof Uint8Array) {
        for (const f of protoFields(config)) if (f.field === 1 && f.value === 1) kind = "cloze";
      }
      notetypes.set(Number(id), { id: Number(id), name: String(name), kind, fields: [], templates: 0 });
    }
    for (const [ntid, name] of rows(db, "SELECT ntid, name FROM fields ORDER BY ntid, ord", (r) => r)) {
      notetypes.get(Number(ntid))?.fields.push(String(name));
    }
    for (const [ntid, n] of rows(db, "SELECT ntid, count(*) FROM templates GROUP BY ntid", (r) => r)) {
      const nt = notetypes.get(Number(ntid));
      if (nt) nt.templates = Number(n);
    }
    for (const [id, name] of rows(db, "SELECT id, name FROM decks", (r) => r)) {
      decks.set(Number(id), String(name).split("\x1f").join("::"));
    }
  } else {
    const [modelsJson, decksJson] = rows(db, "SELECT models, decks FROM col", (r) => r)[0] ?? ["{}", "{}"];
    const models = JSON.parse(text(modelsJson) || "{}") as Record<string, { id?: number; name: string; type?: number; flds?: Array<{ name: string; ord: number }>; tmpls?: unknown[] }>;
    for (const [id, m] of Object.entries(models)) {
      const fields = [...(m.flds ?? [])].sort((a, b) => a.ord - b.ord).map((f) => f.name);
      notetypes.set(Number(id), { id: Number(id), name: m.name, kind: m.type === 1 ? "cloze" : "normal", fields, templates: m.tmpls?.length ?? 1 });
    }
    const deckObj = JSON.parse(text(decksJson) || "{}") as Record<string, { name: string }>;
    for (const [id, d] of Object.entries(deckObj)) decks.set(Number(id), d.name);
  }

  const notes = rows(db, "SELECT id, guid, mid, tags, flds FROM notes ORDER BY id", (r) => ({
    id: Number(r[0]),
    guid: String(r[1]),
    mid: Number(r[2]),
    tags: text(r[3]).trim().split(/\s+/).filter(Boolean),
    fields: text(r[4]).split("\x1f"),
  }));
  // Cards in a filtered deck keep their home deck and due in odid/odue.
  const cards = rows(db, "SELECT id, nid, did, ord, type, queue, due, ivl, factor, flags, odid, odue FROM cards ORDER BY nid, ord", (r) => {
    const odid = Number(r[10] ?? 0);
    return {
      id: Number(r[0]),
      nid: Number(r[1]),
      did: odid ? odid : Number(r[2]),
      ord: Number(r[3]),
      type: Number(r[4]),
      queue: Number(r[5]),
      due: odid ? Number(r[11] ?? 0) : Number(r[6]),
      ivl: Number(r[7]),
      factor: Number(r[8]),
      flags: Number(r[9]),
    };
  });
  const revlog = hasTable(db, "revlog")
    ? rows(db, "SELECT id, cid, ease, ivl, time, type FROM revlog ORDER BY id", (r) => ({
        id: Number(r[0]),
        cid: Number(r[1]),
        ease: Number(r[2]),
        ivl: Number(r[3]),
        time: Number(r[4]),
        type: Number(r[5]),
      }))
    : [];
  return { crt, notetypes, decks, notes, cards, revlog };
}

/** Read the collection and media map from an .apkg (media bytes are fetched later, on demand). */
export function readApkg(bytes: Uint8Array, SQL: SqlJsStatic): AnkiCollection {
  const names = ["collection.anki21b", "collection.anki21", "collection.anki2", "media"];
  const entries = unzipSync(bytes, { filter: (f) => names.includes(f.name) });
  const colName = names.slice(0, 3).find((n) => entries[n]);
  if (!colName) throw new Error("This file doesn't look like an Anki deck package (no collection inside).");
  const colBytes = colName === "collection.anki21b" ? maybeZstd(entries[colName]) : entries[colName];
  const db = new SQL.Database(colBytes);
  try {
    const col = readCollection(db);
    return {
      ...col,
      mediaIndex: entries.media ? parseMediaMap(entries.media) : new Map<string, string>(),
      format: colName === "collection.anki21b" ? "anki21b" : "legacy",
    };
  } finally {
    db.close();
  }
}

/**
 * Extract media in batches, so a large deck never holds all its media in memory at once.
 * Each yielded map can be written out and dropped before the next batch.
 */
export function* readMediaBatches(bytes: Uint8Array, col: AnkiCollection, filenames: Iterable<string>, batch = 40): Generator<Map<string, Uint8Array>> {
  const list = [...filenames].filter((f) => col.mediaIndex.has(f));
  for (let i = 0; i < list.length; i += batch) yield readMedia(bytes, col, list.slice(i, i + batch));
}

/** Extract the given media files (by their Anki filename) from the package. */
export function readMedia(bytes: Uint8Array, col: AnkiCollection, filenames: Iterable<string>): Map<string, Uint8Array> {
  const wanted = new Map<string, string>(); // zip entry → filename
  for (const f of filenames) {
    const z = col.mediaIndex.get(f);
    if (z !== undefined) wanted.set(z, f);
  }
  const out = new Map<string, Uint8Array>();
  if (!wanted.size) return out;
  const entries = unzipSync(bytes, { filter: (f) => wanted.has(f.name) });
  for (const [z, data] of Object.entries(entries)) out.set(wanted.get(z)!, maybeZstd(data));
  return out;
}
