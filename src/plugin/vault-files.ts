/**
 * Data files Obsidian doesn't index (link tables, exam maps are .json): found through the adapter,
 * from the vault root down three folder levels, skipping picture folders, dot-folders and the
 * plugin's own data folder.
 */
import { normalizePath, type App } from "obsidian";

export async function findDataFiles(app: App, stateFolder: string, match: (path: string) => boolean): Promise<string[]> {
  const skip = new Set([normalizePath(stateFolder), app.vault.configDir]);
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let listed: { files: string[]; folders: string[] };
    try {
      listed = await app.vault.adapter.list(dir || "/");
    } catch {
      return;
    }
    out.push(...listed.files.filter(match).map((f) => normalizePath(f)));
    if (depth >= 3) return;
    for (const sub of listed.folders) {
      const path = normalizePath(sub);
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (skip.has(path) || name.startsWith(".") || /^(media|attachments|assets)$/i.test(name)) continue;
      await walk(path, depth + 1);
    }
  };
  await walk("", 0);
  return out;
}

/**
 * A data file names notes by path, possibly from another layout (the Atlas nested in a bigger vault,
 * or a note moved since): try the path, then under the file's own folder, then the note's title.
 */
export function noteResolver(app: App, dataPath: string): (note: string) => string | null {
  const { vault, metadataCache } = app;
  const dir = dataPath.includes("/") ? dataPath.slice(0, dataPath.lastIndexOf("/")) : "";
  const cache = new Map<string, string | null>();
  return (note) => {
    if (cache.has(note)) return cache.get(note)!;
    const found =
      vault.getFileByPath(note)?.path ??
      (dir ? vault.getFileByPath(normalizePath(`${dir}/${note}`))?.path : undefined) ??
      metadataCache.getFirstLinkpathDest(note.replace(/^.*\//, "").replace(/\.md$/i, ""), dataPath)?.path ??
      null;
    cache.set(note, found);
    return found;
  };
}
