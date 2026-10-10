/**
 * What each imported Anki card looked like when it was imported (card ID → sourceHash), so that an
 * update by re-import keeps cards edited in Obsidian instead of overwriting them (spec 0006 §updates).
 * Lives next to the import manifest: `<state folder>/imports/anki-sources.json`.
 */
import { normalizePath, Platform } from "obsidian";
import { sourceHash } from "../core/anki/convert";
import type FlashcardsPlugin from "../main";

function path(plugin: FlashcardsPlugin): string {
  return normalizePath(`${plugin.settings.stateFolder}/imports/anki-sources.json`);
}

export async function loadImportSources(plugin: FlashcardsPlugin): Promise<Map<string, string>> {
  const file = plugin.app.vault.getFileByPath(path(plugin));
  if (!file) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(await plugin.app.vault.cachedRead(file)) as Record<string, string>));
  } catch (e) {
    console.warn("Flashcards: couldn't read the imported-card fingerprints", e);
    return new Map();
  }
}

export async function saveImportSources(plugin: FlashcardsPlugin, map: Map<string, string>): Promise<void> {
  const p = path(plugin);
  const text = JSON.stringify(Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b))));
  const file = plugin.app.vault.getFileByPath(p);
  if (file) await plugin.app.vault.modify(file, text);
  else {
    const dir = p.slice(0, p.lastIndexOf("/"));
    if (!plugin.app.vault.getAbstractFileByPath(dir)) await plugin.app.vault.createFolder(dir).catch(() => undefined);
    await plugin.app.vault.create(p, text);
  }
}

/** Fingerprints of the given cards' current text (one per card ID). */
export function fingerprints(cards: Iterable<{ id?: string; sourceLines: string[] }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of cards) if (c.id && !out.has(c.id)) out.set(c.id, sourceHash(c.sourceLines));
  return out;
}

/**
 * Decks imported before 0.19.3 have no fingerprints: take today's text as the baseline once, so
 * edits from now on are kept. Desktop only, so two devices don't write the file at the same time.
 */
export async function ensureImportBaseline(plugin: FlashcardsPlugin): Promise<void> {
  if (!Platform.isDesktopApp || plugin.app.vault.getFileByPath(path(plugin))) return;
  const imported = plugin.index.refs().filter((r) => !!plugin.app.metadataCache.getCache(r.path)?.frontmatter?.["anki-deck"]);
  if (!imported.length) return;
  await saveImportSources(plugin, fingerprints(imported.map((r) => r.card)));
}
