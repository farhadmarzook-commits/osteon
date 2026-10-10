/** "What I keep missing" (spec 0012): notes ranked by exam misses, with their cards one click away. */
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type FlashcardsPlugin from "../../main";
import { ExamImportModal } from "../modals/exam-import";

export const VIEW_MISSES = "flashcards-misses";

const SOURCE_NAMES: Record<string, string> = { nbme: "NBME", free120: "Free 120", cms: "CMS", amboss: "AMBOSS" };

export class MissesView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: FlashcardsPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_MISSES;
  }

  getDisplayText(): string {
    return "What I keep missing";
  }

  getIcon(): string {
    return "target";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.plugin.events.on("changed", () => this.renderSoon()));
    this.render();
  }

  private timer = 0;
  private renderSoon(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(), 300);
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("fc-misses");
    const exams = this.plugin.exams;
    const head = el.createDiv({ cls: "fc-misses-head" });
    head.createEl("h2", { text: "What I keep missing" });
    const bar = head.createDiv({ cls: "fc-misses-bar" });
    const imp = bar.createEl("button", { text: "Import exam results…" });
    imp.onclick = () => new ExamImportModal(this.app, this.plugin).open();
    const ranking = exams.ranking();
    if (ranking.length) {
      const all = bar.createEl("button", { text: "Study all missed topics", cls: "mod-cta" });
      all.onclick = () => void this.plugin.studySearch("Missed topics", "missed:1");
    }

    const taken = exams.results
      .map((r) => ({ r, e: exams.exams.find((e) => e.id === r.examId) }))
      .filter((x) => x.e)
      .sort((a, b) => b.r.date.localeCompare(a.r.date));
    if (taken.length) {
      const list = el.createDiv({ cls: "fc-muted fc-misses-taken" });
      list.appendText("Imported: ");
      taken.forEach(({ r, e }, i) => {
        if (i) list.appendText(" · ");
        const n = Object.values(r.missed).reduce((s, l) => s + l.length, 0);
        const a = list.createEl("a", { text: `${e!.name} (${n} missed)`, href: "#" });
        a.onclick = (ev) => {
          ev.preventDefault();
          new ExamImportModal(this.app, this.plugin, e!.id).open();
        };
      });
    }

    if (!ranking.length) {
      el.createEl("p", {
        cls: "fc-muted",
        text: exams.exams.length
          ? "No results yet. Import a practice exam to see which topics you keep missing, then study their cards."
          : "No exam maps in this vault yet (*.exammap.json).",
      });
      return;
    }

    // Cards per note: its own plus the imported ones linked to it (one pass over the collection).
    const cards = new Map<string, number>();
    for (const i of this.plugin.items(null)) {
      if (i.state?.suspended) continue;
      for (const p of new Set([i.ref.path, ...this.plugin.links.notesFor(i.ref)])) cards.set(p, (cards.get(p) ?? 0) + 1);
    }
    const table = el.createEl("table", { cls: "fc-misses-table" });
    const hr = table.createEl("thead").createEl("tr");
    for (const h of ["Missed", "Topic", "Where", "Cards", ""]) hr.createEl("th", { text: h });
    const body = table.createEl("tbody");
    for (const m of ranking) {
      const file = this.app.vault.getFileByPath(m.path);
      if (!file) continue;
      const tr = body.createEl("tr");
      tr.createEl("td", { text: `${m.count}×`, cls: m.count >= 3 ? "fc-misses-hot" : "" });
      const a = tr.createEl("td").createEl("a", { text: file.basename, href: "#" });
      a.onclick = (ev) => {
        ev.preventDefault();
        void this.app.workspace.getLeaf(false).openFile(file);
      };
      const where = tr.createEl("td", { cls: "fc-muted", text: m.sources.map((s) => SOURCE_NAMES[s] ?? s).join(", ") });
      where.title = m.where.join("\n");
      const n = cards.get(m.path) ?? 0;
      tr.createEl("td", { text: String(n) });
      const td = tr.createEl("td");
      if (n) {
        const b = td.createEl("button", { text: "Study" });
        b.onclick = () => void this.plugin.studyNote(file);
      }
    }
  }

  async onClose(): Promise<void> {
    window.clearTimeout(this.timer);
  }
}
