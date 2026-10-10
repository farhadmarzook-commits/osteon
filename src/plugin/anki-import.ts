/**
 * Import an Anki deck file (.apkg) into the vault (spec 0006): pick the file, preview, import.
 */
import { App, Modal, normalizePath, Notice, Platform, Setting } from "obsidian";
import initSqlJs from "sql.js/dist/sql-wasm-browser.js";
import type { SqlJsStatic } from "sql.js";
import sqlWasm from "sql.js/dist/sql-wasm.wasm";
import { applyCardUpdates, convertCollection, sourceHash, imageSize, isIoeNotetype, mediaInFields, referencedMedia } from "../core/anki/convert";
import { readApkg, readMedia, readMediaBatches, type AnkiCollection } from "../core/anki/package";
import type { LogEvent } from "../core/log";
import { newCardId } from "../core/ids";
import type FlashcardsPlugin from "../main";
import { fingerprints, loadImportSources, saveImportSources } from "./import-sources";
import { parseNote } from "../core/parser";

let sqlPromise: Promise<SqlJsStatic> | null = null;
function sqlJs(): Promise<SqlJsStatic> {
  const wasmBinary = sqlWasm.buffer.slice(sqlWasm.byteOffset, sqlWasm.byteOffset + sqlWasm.byteLength) as ArrayBuffer;
  sqlPromise ??= initSqlJs({ wasmBinary });
  return sqlPromise;
}

const BIG = 500 * 1024 * 1024;
const MANIFEST_HEADER = "# Imported Anki notes (GUID → card ID) · do not edit by hand";

/** Ask for an .apkg file, then show the preview. */
export function pickAndImportApkg(plugin: FlashcardsPlugin): void {
  const input = createEl("input");
  input.type = "file";
  // iOS greys out file types it doesn't know, so there the extension is checked after picking.
  if (!Platform.isIosApp) input.accept = ".apkg,.colpkg";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!/\.(apkg|colpkg)$/i.test(file.name)) {
      new Notice("Pick an Anki deck file (.apkg).");
      return;
    }
    const notice = new Notice(`Reading ${file.name}…`, 0);
    try {
      if (file.size > BIG) new Notice(`This deck is ${(file.size / 1048576).toFixed(0)} MB. Large decks are best imported on the Mac, and very large ones may not fit in memory.`, 10000);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const col = readApkg(bytes, await sqlJs());
      notice.hide();
      new ApkgImportModal(plugin.app, plugin, file.name, bytes, col).open();
    } catch (e) {
      notice.hide();
      console.error("Flashcards: couldn't read .apkg", e);
      new Notice(`Couldn't read ${file.name}: ${e instanceof Error ? e.message : String(e)}`, 10000);
    }
  };
  input.click();
}

/**
 * Show the import preview for .apkg bytes already in hand (the add-on API and scripts use this;
 * e.g. a deck exported from the desktop app with AnkiConnect). Nothing is written until Import.
 */
export async function openApkgImport(plugin: FlashcardsPlugin, fileName: string, bytes: Uint8Array): Promise<void> {
  const col = readApkg(bytes, await sqlJs());
  new ApkgImportModal(plugin.app, plugin, fileName, bytes, col).open();
}

function manifestPath(plugin: FlashcardsPlugin): string {
  return normalizePath(`${plugin.settings.stateFolder}/imports/anki.md`);
}

/** Imported Anki notes: GUID → card ID (from the manifest), for update by re-import. */
async function importedIds(plugin: FlashcardsPlugin): Promise<Map<string, string>> {
  const file = plugin.app.vault.getFileByPath(manifestPath(plugin));
  const out = new Map<string, string>();
  if (!file) return out;
  for (const line of (await plugin.app.vault.cachedRead(file)).split("\n")) {
    if (!line || line === MANIFEST_HEADER || !line.includes("\t")) continue;
    const [guid, id] = line.split("\t");
    if (guid && id) out.set(guid, id.trim().replace(/^fc-/, ""));
  }
  return out;
}

async function importedGuids(plugin: FlashcardsPlugin): Promise<Set<string>> {
  const file = plugin.app.vault.getFileByPath(manifestPath(plugin));
  const set = new Set<string>();
  if (!file) return set;
  // Anki GUIDs can start with "#", so only the header line is skipped.
  for (const line of (await plugin.app.vault.cachedRead(file)).split("\n")) {
    if (!line || line === MANIFEST_HEADER || !line.includes("\t")) continue;
    set.add(line.split("\t")[0]);
  }
  return set;
}

async function ensureFolder(app: App, dir: string): Promise<void> {
  let cur = "";
  for (const part of dir.split("/")) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur).catch(() => undefined);
  }
}

class ApkgImportModal extends Modal {
  private root = "Anki";
  private includeScheduling: boolean;
  private keepTags = false;
  private skip = new Set<string>();
  private known = new Map<string, string>();
  /** Rewrite cards imported before with the deck's current version (keeps their history). */
  private updateExisting = true;
  /** …but leave cards edited in Obsidian since they were imported. */
  private keepEdits = true;
  /** Card ID → fingerprint of its text as imported (import-sources.ts). */
  private sources = new Map<string, string>();

  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    private fileName: string,
    private bytes: Uint8Array,
    private col: AnkiCollection,
  ) {
    super(app);
    this.includeScheduling = col.revlog.length > 0 || col.cards.some((c) => c.type === 2);
  }

  async onOpen(): Promise<void> {
    this.skip = await importedGuids(this.plugin);
    this.known = await importedIds(this.plugin);
    this.sources = await loadImportSources(this.plugin);
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl, col } = this;
    contentEl.empty();
    this.setTitle(`Import ${this.fileName}`);
    const deckCounts = new Map<string, number>();
    const firstCard = new Map<number, number>();
    for (const c of col.cards) if (!firstCard.has(c.nid)) firstCard.set(c.nid, c.did);
    for (const n of col.notes) {
      const deck = col.decks.get(firstCard.get(n.id) ?? -1) ?? "Default";
      deckCounts.set(deck, (deckCounts.get(deck) ?? 0) + 1);
    }
    const already = col.notes.filter((n) => this.skip.has(n.guid)).length;
    const types = new Map<string, number>();
    for (const n of col.notes) {
      const name = col.notetypes.get(n.mid)?.name ?? "?";
      types.set(name, (types.get(name) ?? 0) + 1);
    }
    const media = referencedMedia(col).size;
    const reviewed = new Set(col.revlog.map((r) => r.cid)).size;

    const facts = contentEl.createEl("ul", { cls: "fc-import-facts" });
    const fact = (t: string) => facts.createEl("li", { text: t });
    fact(`${col.notes.length.toLocaleString()} notes → ${col.cards.length.toLocaleString()} cards, ${media.toLocaleString()} pictures/sounds`);
    fact(`Note types: ${[...types].map(([k, v]) => `${k} (${v})`).join(", ")}`);
    fact(reviewed ? `Review history for ${reviewed.toLocaleString()} cards` : "No review history (cards start as new)");
    if (already) fact(`${already.toLocaleString()} notes were imported before`);
    const decks = contentEl.createDiv({ cls: "fc-import-decks" });
    decks.createDiv({ text: "Decks:", cls: "fc-muted" });
    const ul = decks.createEl("ul");
    for (const [d, c] of [...deckCounts].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 30)) ul.createEl("li", { text: `${d.split("::").join(" › ")} (${c})` });
    if (deckCounts.size > 30) decks.createDiv({ cls: "fc-muted", text: `…and ${deckCounts.size - 30} more` });

    new Setting(contentEl)
      .setName("Folder")
      .setDesc("Imported decks go here, one note per deck.")
      .addText((t) => t.setValue(this.root).onChange((v) => (this.root = v.trim().replace(/^\/+|\/+$/g, "") || "Anki")));
    if (reviewed || col.cards.some((c) => c.type === 2)) {
      new Setting(contentEl)
        .setName("Keep review history")
        .setDesc("Cards keep their Anki schedule and memory state.")
        .addToggle((t) => t.setValue(this.includeScheduling).onChange((v) => (this.includeScheduling = v)));
    }
    if (already)
      new Setting(contentEl)
        .setName("Update cards imported before")
        .setDesc(
          `Rewrite the ${already.toLocaleString()} cards you already have with this deck's current version (e.g. a newer AnKing), keeping their review history. Off: they are skipped.`,
        )
        .addToggle((t) => t.setValue(this.updateExisting).onChange((v) => (this.updateExisting = v)));
    if (already)
      new Setting(contentEl)
        .setName("Keep cards I edited in Obsidian")
        .setDesc("Cards you changed in Obsidian since they were imported are left as they are, not replaced by the deck's version.")
        .addToggle((t) => t.setValue(this.keepEdits).onChange((v) => (this.keepEdits = v)));
    new Setting(contentEl)
      .setName("Keep Anki tags")
      .setDesc("Off by default: shared decks carry very long tag lists.")
      .addToggle((t) => t.setValue(this.keepTags).onChange((v) => (this.keepTags = v)));
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Import")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            b.setButtonText("Importing…");
            await this.runImport();
          }),
      );
  }

  /** Rewrite changed cards in place, file by file (spec 0006 §updates). Returns how many changed. */
  private async applyUpdates(updates: Array<{ id: string; lines: string[] }>, notice: Notice): Promise<{ changed: number; kept: number }> {
    const { plugin } = this;
    const byId = new Map(updates.map((u) => [u.id, u.lines]));
    const byFile = new Map<string, Map<string, string[]>>();
    for (const ref of plugin.index.refs()) {
      const id = ref.card.id;
      if (!id || !byId.has(id)) continue;
      let m = byFile.get(ref.path);
      if (!m) byFile.set(ref.path, (m = new Map<string, string[]>()));
      m.set(id, byId.get(id)!);
    }
    let changed = 0;
    let kept = 0;
    let done = 0;
    const guard = this.keepEdits ? this.sources : undefined;
    for (const [path, m] of byFile) {
      const file = plugin.app.vault.getFileByPath(path);
      if (!file) continue;
      let written: string | null = null;
      await plugin.app.vault.process(file, (text) => {
        const r = applyCardUpdates(text, m, guard);
        changed += r.changed.length;
        kept += r.kept.length;
        for (const id of r.changed) this.sources.set(id, sourceHash(m.get(id)!));
        if (!r.changed.length) return text;
        written = r.text;
        return r.text;
      });
      if (written !== null) plugin.index.updateFromText(file, written);
      if (++done % 10 === 0) notice.setMessage(`Updating existing cards… ${done} / ${byFile.size} notes`);
    }
    if (changed) await saveImportSources(plugin, this.sources);
    return { changed, kept };
  }

  private async runImport(): Promise<void> {
    const { app, plugin, col } = this;
    const notice = new Notice("Importing…", 0);
    try {
      // Updating cards imported before needs every card, including those in hidden decks.
      await plugin.index.setWithHidden(true);
      // Image sizes are only needed for occlusion shapes stored in pixels: read just those images.
      // The old Image Occlusion Enhanced add-on keeps its boxes in SVG files: read just those.
      const ioImages = new Set<string>();
      for (const n of col.notes) {
        const nt = col.notetypes.get(n.mid);
        const occ = n.fields.find((f) => f.includes("image-occlusion:"));
        if (occ) for (const f of mediaInFields(n.fields)) ioImages.add(f);
        else if (nt && isIoeNotetype(nt)) for (const f of mediaInFields(n.fields)) if (/-O\.svg$/i.test(f)) ioImages.add(f);
      }
      const sizes = new Map<string, { width: number; height: number }>();
      const texts = new Map<string, string>();
      const decoder = new TextDecoder();
      for (const [name, data] of readMedia(this.bytes, col, ioImages)) {
        if (/\.svg$/i.test(name)) {
          texts.set(name, decoder.decode(data));
          continue;
        }
        const s = imageSize(data);
        if (s) sizes.set(name, s);
      }
      const existing = new Set(app.vault.getFiles().map((f) => f.path.toLowerCase()));
      const taken = new Set<string>();
      const result = convertCollection(col, {
        root: this.root,
        keepTags: this.keepTags,
        includeScheduling: this.includeScheduling,
        skipGuids: this.skip,
        updateIds: this.updateExisting ? this.known : undefined,
        newId: () => {
          const id = newCardId((x) => taken.has(x) || plugin.index.hasId(x));
          taken.add(id);
          return id;
        },
        now: new Date(),
        imageSize: (f) => sizes.get(f) ?? null,
        readText: (f) => texts.get(f) ?? null,
        // Mac and iPhone file systems ignore case.
        pathExists: (p) => existing.has(p.toLowerCase()),
      });
      const { changed: updated, kept } = result.updates.length ? await this.applyUpdates(result.updates, notice) : { changed: 0, kept: 0 };
      const keptNote = kept ? ` ${kept.toLocaleString()} card${kept === 1 ? "" : "s"} you edited in Obsidian were kept as they are.` : "";
      if (!result.files.length) {
        notice.hide();
        new Notice(
          result.updates.length
            ? `No new notes. ${updated.toLocaleString()} of ${result.updates.length.toLocaleString()} existing cards had changed and were updated (history kept).${keptNote}`
            : result.stats.skipped
              ? "Every note in this deck was already imported."
              : "No cards found in this deck.",
          10000,
        );
        this.close();
        return;
      }
      if (updated || kept) new Notice(`${updated.toLocaleString()} existing cards were updated to the deck's current version (history kept).${keptNote}`, 10000);

      // Pictures and sounds, a few at a time, so a large deck never holds all its media in memory.
      let written = 0;
      let done = 0;
      const total = result.media.size;
      for (const batch of readMediaBatches(this.bytes, col, result.media.keys())) {
        for (const [name, data] of batch) {
          done++;
          const path = result.media.get(name)!;
          if (existing.has(path.toLowerCase())) continue;
          await ensureFolder(app, path.slice(0, path.lastIndexOf("/")));
          try {
            await app.vault.createBinary(path, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
            existing.add(path.toLowerCase());
            written++;
          } catch (e) {
            console.warn(`Flashcards: couldn't write ${path}`, e);
          }
        }
        notice.setMessage(`Writing pictures… ${done}/${total}`);
      }

      // Notes: each file on its own, so one failure doesn't lose the rest (or their history).
      notice.setMessage("Writing notes…");
      const okIds = new Set<string>();
      const okGuids: Array<{ guid: string; id: string; hub: string }> = [];
      let failed = 0;
      for (const f of result.files) {
        try {
          await ensureFolder(app, f.path.slice(0, f.path.lastIndexOf("/")));
          await app.vault.create(f.path, f.content);
          for (const [id, h] of fingerprints(parseNote(f.content))) this.sources.set(id, h);
          f.ids.forEach((id, i) => {
            okIds.add(id);
            okGuids.push({ guid: f.guids[i], id, hub: f.hubs[i] });
          });
        } catch (e) {
          failed++;
          console.error(`Flashcards: couldn't create ${f.path}`, e);
        }
      }

      // Remember what was imported, so re-importing an updated deck only adds new notes.
      if (okGuids.length) {
        await saveImportSources(plugin, this.sources);
        const mpath = manifestPath(plugin);
        await ensureFolder(app, mpath.slice(0, mpath.lastIndexOf("/")));
        // A third column with the AnkiHub ID, when there is one, for link tables (spec 0011).
        const lines = okGuids.map((g) => `${g.guid}\tfc-${g.id}${g.hub ? `\t${g.hub}` : ""}`).join("\n") + "\n";
        const mfile = app.vault.getFileByPath(mpath);
        if (mfile) await app.vault.append(mfile, lines);
        else await app.vault.create(mpath, `${MANIFEST_HEADER}\n\n${lines}`);
      }
      const events: LogEvent[] = result.events.filter((e) => okIds.has(e.key.split(".")[0]));
      if (failed) new Notice(`${failed} deck file(s) couldn't be written; see the developer console.`, 10000);

      await plugin.logEvents(events);
      notice.hide();
      const s = result.stats;
      new Notice(
        `Imported ${s.notes.toLocaleString()} notes (${s.cards.toLocaleString()} cards) into ${result.files.length} note${result.files.length === 1 ? "" : "s"}` +
          `${written ? `, ${written} pictures` : ""}${s.withHistory ? `; ${s.withHistory.toLocaleString()} cards kept their history` : ""}` +
          `${s.skipped ? `; ${s.skipped} skipped (already imported)` : ""}${s.empty + s.unsupported ? `; ${s.empty + s.unsupported} empty or unsupported` : ""}.`,
        12000,
      );
      this.close();
      void plugin.openDecks();
    } catch (e) {
      notice.hide();
      console.error("Flashcards: import failed", e);
      new Notice(`Import failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
      this.close();
    }
  }
}
