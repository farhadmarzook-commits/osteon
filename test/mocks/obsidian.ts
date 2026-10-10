/** Minimal in-memory stand-ins for the parts of the Obsidian API the plugin's data layer uses. */

export class TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop()!;
    this.extension = this.name.includes(".") ? this.name.split(".").pop()! : "";
    this.basename = this.name.replace(/\.[^.]+$/, "");
  }
}

export class TFolder {
  constructor(public path: string) {}
}

export class Events {
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  on(name: string, fn: (...a: unknown[]) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
    return { name, fn };
  }
  trigger(name: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(name) ?? []) fn(...args);
  }
}

export const Platform = { isIosApp: false, isTablet: false, isAndroidApp: false, isMacOS: true, isMobile: false };

export function normalizePath(p: string): string {
  return p.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export interface CachedMetadata {
  tags: string[];
}

export function getAllTags(cache: CachedMetadata): string[] {
  return cache.tags;
}

export class Vault {
  files = new Map<string, string>();
  folders = new Set<string>();
  writes: string[] = [];

  getMarkdownFiles(): TFile[] {
    return [...this.files.keys()].filter((p) => p.endsWith(".md")).map((p) => new TFile(p));
  }
  getAbstractFileByPath(p: string): TFile | TFolder | null {
    if (this.files.has(p)) return new TFile(p);
    if (this.folders.has(p)) return new TFolder(p);
    return null;
  }
  getFileByPath(p: string): TFile | null {
    return this.files.has(p) ? new TFile(p) : null;
  }
  async read(f: TFile): Promise<string> {
    return this.files.get(f.path) ?? "";
  }
  async cachedRead(f: TFile): Promise<string> {
    return this.read(f);
  }
  async create(p: string, data: string): Promise<TFile> {
    if (this.files.has(p)) throw new Error("exists");
    this.files.set(p, data);
    this.writes.push(p);
    return new TFile(p);
  }
  async append(f: TFile, data: string): Promise<void> {
    this.files.set(f.path, (this.files.get(f.path) ?? "") + data);
    this.writes.push(f.path);
  }
  async process(f: TFile, fn: (d: string) => string): Promise<string> {
    const out = fn(this.files.get(f.path) ?? "");
    this.files.set(f.path, out);
    this.writes.push(f.path);
    return out;
  }
  async createFolder(p: string): Promise<void> {
    this.folders.add(p);
  }
}

export class MetadataCache {
  constructor(private vault: Vault) {}
  getFileCache(f: TFile): CachedMetadata {
    const text = this.vault.files.get(f.path) ?? "";
    const tags = new Set<string>();
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    if (fm) {
      const m = /tags:\s*\[([^\]]*)\]/.exec(fm[1]);
      m?.[1].split(",").forEach((t) => tags.add("#" + t.trim()));
    }
    for (const m of text.matchAll(/(?:^|\s)#([A-Za-z][\w/-]*)/g)) tags.add("#" + m[1]);
    return { tags: [...tags] };
  }
}

export class App {
  vault = new Vault();
  metadataCache = new MetadataCache(this.vault);
  private local = new Map<string, unknown>();
  loadLocalStorage(k: string) {
    return this.local.get(k) ?? null;
  }
  saveLocalStorage(k: string, v: unknown) {
    this.local.set(k, v);
  }
}

export class PluginSettingTab {
  constructor(..._args: unknown[]) {}
}
export class Setting {}
export class Modal {
  constructor(..._args: unknown[]) {}
}
export class Notice {
  constructor(..._args: unknown[]) {}
}
