/**
 * The medical-term hover (spec 0005 §2): underline terms on a rendered card, show a popup with
 * a definition (and pictures when the definition comes from one of his notes). No links.
 */
import { Component, debounce, MarkdownRenderer, Notice, Platform, requestUrl, TFile } from "obsidian";
import {
  buildDictionary,
  findTerms,
  meshEntries,
  MY_TERMS_TEMPLATE,
  noteSummary,
  parseAiGlossary,
  parseMeshAscii,
  parseMyTerms,
  termTokens,
  type Dictionary,
  type MeshRecord,
  type TermEntry,
} from "../core/terms";
import type FlashcardsPlugin from "../main";

// ---- a tiny IndexedDB key-value store (MeSH lives on each device, not in the vault) ----------

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(db: string, key: string): Promise<T | undefined> {
  const d = await openDb(db);
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction("kv", "readonly");
      const req = tx.objectStore("kv").get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB read aborted"));
    });
  } finally {
    d.close();
  }
}

async function idbSet(db: string, key: string, value: unknown): Promise<void> {
  const d = await openDb(db);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      // A quota failure aborts without an error event.
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted (storage full?)"));
    });
  } finally {
    d.close();
  }
}

interface StoredMesh {
  year: number;
  records: MeshRecord[];
}

const SKIP_TAGS = new Set(["CODE", "PRE", "A", "BUTTON", "SVG", "MARK", "SCRIPT", "STYLE", "KBD", "MATH", "MJX-CONTAINER"]);

export class TermService {
  /** Layers in precedence order: his notes + list (cheap, rebuilt often), MeSH (big, cached), AI. */
  private personal: Dictionary | null = null;
  private meshDict: Dictionary | null = null;
  private meshKey = "";
  private aiDict: Dictionary | null = null;
  private hidden = new Set<string>();
  private aliasSig = new Map<string, string>();
  private showTimers = new Set<number>();
  private mesh: StoredMesh | null = null;
  private meshLoaded = false;
  private popup?: HTMLElement;
  private popupComponent?: Component;
  private hideTimer = 0;

  constructor(private plugin: FlashcardsPlugin) {}

  private get dbName(): string {
    return `flashcards-${this.plugin.app.vault.getName()}`;
  }

  get glossaryFolder(): string {
    return `${this.plugin.settings.stateFolder}/glossary`;
  }

  get myTermsPath(): string {
    return `${this.glossaryFolder}/My terms.md`;
  }

  get aiFolder(): string {
    return `${this.glossaryFolder}/ai`;
  }

  async init(): Promise<void> {
    try {
      this.mesh = (await idbGet<StoredMesh>(this.dbName, "mesh")) ?? null;
    } catch (e) {
      console.warn("Flashcards: couldn't read MeSH from local storage", e);
    }
    this.meshLoaded = true;
    await this.rebuild();
  }

  hasMesh(): boolean {
    return !!this.mesh;
  }

  meshStatus(): string {
    if (!this.meshLoaded) return "";
    return this.mesh ? `Installed: ${this.mesh.year} edition, ${this.mesh.records.length.toLocaleString()} terms.` : "Not downloaded yet.";
  }

  /** Download NLM's ASCII MeSH descriptors (newest available year), filter, and store locally. */
  async downloadMesh(): Promise<void> {
    const now = new Date().getFullYear();
    const notice = new Notice("Downloading MeSH (about 30 MB)…", 0);
    try {
      // NLM keeps the current edition in MESH_FILES/ (when it publishes the ASCII form) and each
      // past edition in its year folder; a missing file redirects to an HTML error page, which
      // the *NEWRECORD check below rejects.
      const base = "https://nlmpubs.nlm.nih.gov/projects/mesh";
      const candidates: Array<[number, string]> = [];
      for (const year of [now + 1, now]) candidates.push([year, `${base}/MESH_FILES/asciimesh/d${year}.bin`]);
      for (const year of [now + 1, now, now - 1, now - 2]) candidates.push([year, `${base}/${year}/asciimesh/d${year}.bin`]);
      for (const [year, url] of candidates) {
        let records: MeshRecord[] | null = null;
        {
          const res = await requestUrl({ url, throw: false });
          if (res.status !== 200) continue;
          const text = res.text;
          if (!text.startsWith("*NEWRECORD") && !text.slice(0, 2000).includes("*NEWRECORD")) continue;
          notice.setMessage("Processing MeSH…");
          await new Promise((r) => window.setTimeout(r, 30));
          records = parseMeshAscii(text);
        }
        // The response and its text are out of scope here, so they can be freed before storing.
        this.mesh = { year, records };
        try {
          await idbSet(this.dbName, "mesh", this.mesh);
        } catch (e) {
          console.warn("Flashcards: couldn't store MeSH on this device; it will be used until restart", e);
        }
        await this.rebuild();
        notice.hide();
        new Notice(`MeSH ${year} installed: ${records.length.toLocaleString()} terms.`);
        return;
      }
      notice.hide();
      new Notice("Couldn't download MeSH from nlm.nih.gov. Check the connection and try again.");
    } catch (e) {
      notice.hide();
      console.error("Flashcards: MeSH download failed", e);
      new Notice("MeSH download failed. See the developer console for details.");
    }
  }

  rebuildSoon = debounce(() => void this.rebuild(), 1500, true);

  /**
   * Call on a metadata change: only rebuild when the change matters (a note's aliases, My terms,
   * or an AI glossary file), so typing in a note never re-tokenises MeSH.
   */
  onFileChanged(path: string): void {
    if (path === this.myTermsPath || path.startsWith(this.aiFolder + "/")) {
      this.rebuildSoon();
      return;
    }
    const file = this.plugin.app.vault.getFileByPath(path);
    if (!file) return;
    const sig = JSON.stringify(this.aliasesOf(file));
    if ((this.aliasSig.get(path) ?? "[]") !== sig) this.rebuildSoon();
  }

  private aliasesOf(f: TFile): string[] {
    const fm = this.plugin.app.metadataCache.getFileCache(f)?.frontmatter;
    const raw = fm?.aliases ?? fm?.alias;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : typeof raw === "string" ? [raw] : [];
  }

  /** Rebuild the layers; the MeSH layer only when MeSH, sensitivity or the hide list changed. */
  async rebuild(): Promise<void> {
    const s = this.plugin.settings.hover;
    const { vault } = this.plugin.app;
    const personal: TermEntry[] = [];
    const hidden = new Set<string>();
    this.aliasSig.clear();

    if (s.useNotes) {
      for (const f of vault.getMarkdownFiles()) {
        if (!this.isStudyNote(f)) continue;
        if (/^\d[\d\s\-_.]*$/.test(f.basename) || f.basename.length < 3) continue;
        const aliases = this.aliasesOf(f);
        if (aliases.length) this.aliasSig.set(f.path, JSON.stringify(aliases));
        personal.push({ term: f.basename, variants: [f.basename, ...aliases], definition: "", source: "note", notePath: f.path });
      }
    }
    const myFile = vault.getFileByPath(this.myTermsPath);
    if (myFile) {
      const mine = parseMyTerms(await vault.cachedRead(myFile));
      // His list comes first so his own definitions beat a note title of the same name.
      personal.unshift(...mine.defs.map((d) => ({ term: d.term, variants: [d.term, ...d.aliases], definition: d.definition, source: "list" as const })));
      for (const h of mine.hidden) hidden.add(termTokens(h).join(" "));
    }
    this.hidden = hidden;
    const opts = { sensitivity: s.sensitivity, hidden };
    this.personal = buildDictionary(personal, opts);

    const meshKey = `${s.useMesh}|${this.mesh?.year ?? 0}|${this.mesh?.records.length ?? 0}|${s.sensitivity}|${[...hidden].sort().join(",")}`;
    if (meshKey !== this.meshKey) {
      this.meshDict = s.useMesh && this.mesh ? buildDictionary(meshEntries(this.mesh.records), opts) : null;
      this.meshKey = meshKey;
    }

    const aiTexts: string[] = [];
    for (const f of vault.getMarkdownFiles()) {
      if (f.path.startsWith(this.aiFolder + "/")) aiTexts.push(await vault.cachedRead(f));
    }
    const ai = parseAiGlossary(aiTexts).terms.map((t) => ({ term: t.term, variants: [t.term], definition: t.definition, source: "ai" as const }));
    this.aiDict = buildDictionary(ai, opts);
  }

  /**
   * Notes worth defining a term or linking to: not review data, not a folder excluded in
   * Obsidian's settings, and not a card-storage note made by an Anki import (anki-deck).
   */
  isStudyNote(f: TFile): boolean {
    const { app } = this.plugin;
    if (f.path.startsWith(this.plugin.settings.stateFolder + "/")) return false;
    const ignored = ((app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.("userIgnoreFilters") ?? []) as string[];
    if (Array.isArray(ignored) && ignored.some((p) => typeof p === "string" && p && f.path.startsWith(p))) return false;
    return !app.metadataCache.getFileCache(f)?.frontmatter?.["anki-deck"];
  }

  /** Study notes a card's text mentions by title or alias, most specific first (for "Related"). */
  relatedNotes(text: string, exclude: string[] = [], max = 3): TFile[] {
    if (!this.personal || max <= 0) return [];
    const seen = new Set<string>(exclude);
    const found = findTerms(text, [this.personal])
      .filter((m) => m.entry.source === "note" && m.entry.notePath)
      .sort((a, b) => b.entry.term.length - a.entry.term.length);
    const out: TFile[] = [];
    for (const m of found) {
      const path = m.entry.notePath!;
      if (seen.has(path)) continue;
      seen.add(path);
      const f = this.plugin.app.vault.getFileByPath(path);
      if (f) out.push(f);
      if (out.length >= max) break;
    }
    return out;
  }

  /** Open a note beside the reviewer (a new tab on the iPhone). */
  async openBeside(file: TFile): Promise<void> {
    const { workspace } = this.plugin.app;
    const leaf = Platform.isMobile ? workspace.getLeaf("tab") : workspace.getLeaf("split");
    await leaf.openFile(file);
  }

  private layers(): Dictionary[] {
    return [this.personal, this.meshDict, this.aiDict].filter((d): d is Dictionary => !!d && d.size > 0);
  }

  async openMyTerms(): Promise<void> {
    const { vault, workspace } = this.plugin.app;
    let file = vault.getFileByPath(this.myTermsPath);
    if (!file) {
      for (const dir of [this.plugin.settings.stateFolder, this.glossaryFolder]) {
        if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir).catch(() => undefined);
      }
      file = await vault.create(this.myTermsPath, MY_TERMS_TEMPLATE);
    }
    await workspace.getLeaf("tab").openFile(file);
  }

  // ---- decorating rendered cards ------------------------------------------------------------

  /** Underline known terms inside `root` (text nodes only; code, links and clozes are skipped). */
  decorate(root: HTMLElement, sourcePath: string): void {
    const layers = this.layers();
    if (!layers.length) return;
    const already = new Set<TermEntry>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        let p = node.parentElement;
        while (p && p !== root) {
          if (SKIP_TAGS.has(p.tagName.toUpperCase()) || p.classList.contains("fc-cloze") || p.classList.contains("fc-term") || p.classList.contains("fc-io") || p.classList.contains("math")) {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentElement;
        }
        return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    for (const node of nodes) {
      const text = node.nodeValue ?? "";
      const matches = findTerms(text, layers, already);
      if (!matches.length) continue;
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const m of matches) {
        frag.append(text.slice(pos, m.start));
        const span = document.createElement("span");
        span.className = "fc-term";
        span.textContent = text.slice(m.start, m.end);
        this.attach(span, m.entry, sourcePath);
        frag.append(span);
        pos = m.end;
      }
      frag.append(text.slice(pos));
      node.replaceWith(frag);
    }
  }

  private attach(span: HTMLElement, entry: TermEntry, sourcePath: string): void {
    if (Platform.isMobile) {
      span.addEventListener("click", (e) => {
        // A tap on a term opens its definition; it never counts as "tap to reveal".
        e.stopPropagation();
        e.preventDefault();
        void this.show(span, entry, sourcePath);
      });
      return;
    }
    let timer = 0;
    span.addEventListener("mouseenter", () => {
      window.clearTimeout(this.hideTimer);
      timer = window.setTimeout(() => {
        this.showTimers.delete(timer);
        void this.show(span, entry, sourcePath);
      }, 330);
      this.showTimers.add(timer);
    });
    span.addEventListener("mouseleave", () => {
      window.clearTimeout(timer);
      this.showTimers.delete(timer);
      this.hideSoon();
    });
    span.addEventListener("click", (e) => e.stopPropagation());
  }

  private hideSoon(): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), 250);
  }

  hide(): void {
    for (const t of this.showTimers) window.clearTimeout(t);
    this.showTimers.clear();
    window.clearTimeout(this.hideTimer);
    this.popup?.remove();
    this.popup = undefined;
    this.popupComponent?.unload();
    this.popupComponent = undefined;
  }

  private async show(anchor: HTMLElement, entry: TermEntry, sourcePath: string): Promise<void> {
    // The card may have moved on (rated, revealed) since the hover started.
    if (!anchor.isConnected) return;
    this.hide();
    const pop = document.body.createDiv({ cls: "fc-term-popup" });
    this.popup = pop;
    this.popupComponent = new Component();
    this.popupComponent.load();
    pop.addEventListener("mouseenter", () => window.clearTimeout(this.hideTimer));
    pop.addEventListener("mouseleave", () => this.hideSoon());
    pop.addEventListener("click", (e) => e.stopPropagation());

    const head = pop.createDiv({ cls: "fc-term-head" });
    head.createSpan({ cls: "fc-term-title", text: entry.term });
    const label = { note: "Your note", list: "Your list", mesh: "MeSH", ai: "AI" }[entry.source];
    head.createSpan({ cls: `fc-term-source fc-term-source-${entry.source}`, text: label });
    const body = pop.createDiv({ cls: "fc-term-body" });

    if (entry.source === "note" && entry.notePath) {
      const file = this.plugin.app.vault.getFileByPath(entry.notePath);
      if (file instanceof TFile) {
        const summary = noteSummary(await this.plugin.app.vault.cachedRead(file));
        if (this.popup !== pop) return;
        body.createDiv({ text: summary.definition || "(This note has no text paragraph yet.)" });
        if (summary.images.length) {
          const imgs = body.createDiv({ cls: "fc-term-images markdown-rendered" });
          await MarkdownRenderer.render(this.plugin.app, summary.images.join("\n\n"), imgs, file.path, this.popupComponent!);
          if (this.popup !== pop) return;
        }
        const open = pop.createEl("a", { cls: "fc-term-open", text: "Open note →", href: "#" });
        open.onclick = (e) => {
          e.preventDefault();
          this.hide();
          void this.openBeside(file);
        };
      }
    } else {
      body.createDiv({ text: entry.definition });
    }
    if (this.popup !== pop || !anchor.isConnected) {
      if (this.popup === pop) this.hide();
      return;
    }
    this.position(pop, anchor);

    if (Platform.isMobile) {
      const close = (e: Event) => {
        if (!pop.contains(e.target as Node)) {
          this.hide();
          document.removeEventListener("pointerdown", close, true);
        }
      };
      window.setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
    }
    void sourcePath;
  }

  private position(pop: HTMLElement, anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(360, vw - 16);
    pop.style.width = `${width}px`;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), vw - width - 8);
    pop.style.left = `${left}px`;
    // Below the word if there's room, else above.
    const h = pop.offsetHeight;
    const below = r.bottom + 8;
    pop.style.top = `${below + h < vh - 8 ? below : Math.max(8, r.top - h - 8)}px`;
  }
}
