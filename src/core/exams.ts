/**
 * Exam results (spec 0012): an exam map (`*.exammap.json`) says which study note each question of a
 * practice form tests (form → block → item → note paths; no question content). A student enters the
 * items they missed, and the plugin counts misses per note: a "What I keep missing" list, `missed:`
 * searches, and weak-area tags. Pure and tested.
 */

export interface ExamBlock {
  name: string;
  /** Item number (as a string) → study note paths. */
  items: Record<string, string[]>;
}

export interface Exam {
  id: string;
  name: string;
  /** "nbme", "free120", "cms", "amboss"…: becomes the weak-area tag suffix. */
  source: string;
  blocks: ExamBlock[];
}

export interface ExamMap {
  version: number;
  exams: Exam[];
}

export const EXAM_MAP_SUFFIX = ".exammap.json";

export function isExamMap(path: string): boolean {
  return path.toLowerCase().endsWith(EXAM_MAP_SUFFIX);
}

export function parseExamMap(json: string): ExamMap {
  const raw = JSON.parse(json) as Partial<ExamMap>;
  if (!raw || !Array.isArray(raw.exams)) throw new Error("not an exam map (no exams array)");
  const exams = raw.exams
    .filter((e): e is Exam => !!e && typeof e.id === "string" && typeof e.name === "string" && Array.isArray(e.blocks))
    .map((e) => ({
      id: e.id,
      name: e.name,
      source: typeof e.source === "string" && e.source ? e.source : "exam",
      blocks: e.blocks
        .filter((b) => b && typeof b.name === "string" && b.items && typeof b.items === "object")
        .map((b) => ({
          name: b.name,
          items: Object.fromEntries(Object.entries(b.items).map(([k, v]) => [k, Array.isArray(v) ? v.filter((p) => typeof p === "string") : []])),
        })),
    }));
  return { version: Number(raw.version) || 1, exams };
}

/** "3, 7, 12-14" → [3, 7, 12, 13, 14] (sorted, unique; anything else is ignored). */
export function parseItemList(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[\s,;]+/)) {
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
      for (let n = a; n <= b && n - a < 500; n++) out.add(n);
    } else if (/^\d+$/.test(part)) out.add(Number(part));
  }
  return [...out].sort((a, b) => a - b);
}

/** One sitting of one form: the items missed in each block. */
export interface ExamResult {
  examId: string;
  /** YYYY-MM-DD */
  date: string;
  missed: Record<string, number[]>;
}

export interface NoteMisses {
  path: string;
  count: number;
  /** "NBME 13 · Section 2 #14", newest first. */
  where: string[];
  sources: string[];
}

/**
 * Misses per study note across every saved result. `resolve` maps a map path to the note's current
 * vault path (or null if it's gone), as for link tables.
 */
export function missesByNote(exams: Exam[], results: ExamResult[], resolve: (p: string) => string | null = (p) => p): Map<string, NoteMisses> {
  const byId = new Map(exams.map((e) => [e.id, e]));
  const out = new Map<string, NoteMisses>();
  const sorted = [...results].sort((a, b) => b.date.localeCompare(a.date));
  for (const r of sorted) {
    const exam = byId.get(r.examId);
    if (!exam) continue;
    for (const block of exam.blocks) {
      for (const n of r.missed[block.name] ?? []) {
        for (const p of block.items[String(n)] ?? []) {
          const path = resolve(p);
          if (!path) continue;
          let m = out.get(path);
          if (!m) out.set(path, (m = { path, count: 0, where: [], sources: [] }));
          m.count++;
          m.where.push(`${exam.name} · ${block.name} #${n}`);
          if (!m.sources.includes(exam.source)) m.sources.push(exam.source);
        }
      }
    }
  }
  return out;
}

/** Items a student entered that the map has no note for (shown so they aren't silently lost). */
export function unmappedItems(exam: Exam, missed: Record<string, number[]>): string[] {
  const out: string[] = [];
  for (const b of exam.blocks) for (const n of missed[b.name] ?? []) if (!(b.items[String(n)] ?? []).length) out.push(`${b.name} #${n}`);
  return out;
}

/** The weak-area tag for a source: "weak-area-nbme". */
export function weakTag(source: string): string {
  return `weak-area-${source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "exam"}`;
}
