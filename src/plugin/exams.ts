/**
 * Exam results (spec 0012): loads every `*.exammap.json` and the student's saved results
 * (`<state folder>/exams/<exam id>.json`), and answers "how often was this note missed?".
 */
import { normalizePath, Notice, TFile } from "obsidian";
import { isExamMap, missesByNote, parseExamMap, weakTag, type Exam, type ExamResult, type NoteMisses } from "../core/exams";
import type FlashcardsPlugin from "../main";
import { findDataFiles, noteResolver } from "./vault-files";

export class ExamService {
  exams: Exam[] = [];
  results: ExamResult[] = [];
  private misses = new Map<string, NoteMisses>();
  /** Exam id → the map file it came from (paths in it resolve relative to that file). */
  private mapOf = new Map<string, string>();

  constructor(private plugin: FlashcardsPlugin) {}

  private get folder(): string {
    return normalizePath(`${this.plugin.settings.stateFolder}/exams`);
  }

  private resultPath(examId: string): string {
    return normalizePath(`${this.folder}/${examId.replace(/[^a-z0-9-]+/gi, "-")}.json`);
  }

  async load(): Promise<void> {
    const { app } = this.plugin;
    const exams: Exam[] = [];
    this.mapOf.clear();
    for (const path of await findDataFiles(app, this.plugin.settings.stateFolder, isExamMap)) {
      try {
        for (const e of parseExamMap(await app.vault.adapter.read(path)).exams) {
          if (this.mapOf.has(e.id)) continue; // first map wins for a duplicated form
          exams.push(e);
          this.mapOf.set(e.id, path);
        }
      } catch (err) {
        console.warn(`Flashcards: ${path} isn't a valid exam map`, err);
      }
    }
    this.exams = exams;
    const results: ExamResult[] = [];
    if (await app.vault.adapter.exists(this.folder)) {
      for (const f of (await app.vault.adapter.list(this.folder)).files.filter((f) => f.endsWith(".json"))) {
        try {
          const r = JSON.parse(await app.vault.adapter.read(f)) as ExamResult;
          if (r && typeof r.examId === "string" && r.missed) results.push(r);
        } catch (err) {
          console.warn(`Flashcards: couldn't read exam result ${f}`, err);
        }
      }
    }
    this.results = results;
    this.recount();
  }

  private recount(): void {
    const merged = new Map<string, NoteMisses>();
    // Resolve each exam's paths against its own map file.
    for (const e of this.exams) {
      const mine = this.results.filter((r) => r.examId === e.id);
      if (!mine.length) continue;
      for (const [path, m] of missesByNote([e], mine, noteResolver(this.plugin.app, this.mapOf.get(e.id) ?? ""))) {
        const cur = merged.get(path);
        if (!cur) merged.set(path, m);
        else {
          cur.count += m.count;
          cur.where.push(...m.where);
          for (const s of m.sources) if (!cur.sources.includes(s)) cur.sources.push(s);
        }
      }
    }
    this.misses = merged;
    this.plugin.events.trigger("changed");
  }

  /** Times a note was missed across imported exams. */
  missed(path: string): number {
    return this.misses.get(path)?.count ?? 0;
  }

  /** Every missed note, most missed first. */
  ranking(): NoteMisses[] {
    return [...this.misses.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  }

  result(examId: string): ExamResult | undefined {
    return this.results.find((r) => r.examId === examId);
  }

  /** Save (or replace) one form's result, then tag the missed notes if the setting is on. */
  async save(result: ExamResult): Promise<number> {
    const { adapter } = this.plugin.app.vault;
    if (!(await adapter.exists(this.folder))) await this.plugin.app.vault.createFolder(this.folder).catch(() => undefined);
    await adapter.write(this.resultPath(result.examId), JSON.stringify(result, null, 1));
    this.results = [...this.results.filter((r) => r.examId !== result.examId), result];
    this.recount();
    const exam = this.exams.find((e) => e.id === result.examId);
    if (!exam || !this.plugin.settings.tagExamMisses) return 0;
    return this.tagNotes(exam, result);
  }

  async remove(examId: string): Promise<void> {
    const path = this.resultPath(examId);
    if (await this.plugin.app.vault.adapter.exists(path)) await this.plugin.app.vault.adapter.remove(path);
    this.results = this.results.filter((r) => r.examId !== examId);
    this.recount();
  }

  /** Add `weak-area-<source>` to each missed note's frontmatter tags (never removes anything). */
  private async tagNotes(exam: Exam, result: ExamResult): Promise<number> {
    const tag = weakTag(exam.source);
    const resolve = noteResolver(this.plugin.app, this.mapOf.get(exam.id) ?? "");
    const paths = new Set<string>();
    for (const b of exam.blocks) for (const n of result.missed[b.name] ?? []) for (const p of b.items[String(n)] ?? []) {
      const r = resolve(p);
      if (r) paths.add(r);
    }
    let tagged = 0;
    for (const path of paths) {
      const file = this.plugin.app.vault.getFileByPath(path);
      if (!(file instanceof TFile)) continue;
      try {
        await this.plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          const raw = fm.tags;
          const tags = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[,\s]+/).filter(Boolean) : [];
          if (tags.some((t) => t.replace(/^#/, "") === tag)) return;
          fm.tags = [...tags, tag];
          tagged++;
        });
      } catch (err) {
        console.warn(`Flashcards: couldn't tag ${path}`, err);
      }
    }
    if (tagged) new Notice(`Tagged ${tagged} note${tagged === 1 ? "" : "s"} #${tag}.`);
    return tagged;
  }
}
