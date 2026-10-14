/** Import exam results (spec 0012): pick a form, type the missed item numbers per block, save. */
import { App, Modal, Notice, Setting } from "obsidian";
import { parseItemList, unmappedItems, type Exam } from "../../core/exams";
import type FlashcardsPlugin from "../../main";
import { destructive } from "../compat";

const SOURCE_NAMES: Record<string, string> = { nbme: "NBME", free120: "Free 120", cms: "NBME CMS", amboss: "AMBOSS" };

export class ExamImportModal extends Modal {
  private exam: Exam | undefined;
  private date = new Date().toISOString().slice(0, 10);
  private text: Record<string, string> = {};

  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    examId?: string,
  ) {
    super(app);
    this.pick(examId ?? plugin.exams.exams[0]?.id);
  }

  private pick(id: string | undefined): void {
    this.exam = this.plugin.exams.exams.find((e) => e.id === id);
    const saved = this.exam && this.plugin.exams.result(this.exam.id);
    this.date = saved?.date ?? new Date().toISOString().slice(0, 10);
    this.text = Object.fromEntries((this.exam?.blocks ?? []).map((b) => [b.name, (saved?.missed[b.name] ?? []).join(", ")]));
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("Import exam results");
    const exams = this.plugin.exams.exams;
    if (!exams.length) {
      contentEl.createEl("p", {
        text: "No exam maps found. An exam map is a *.exammap.json file (the Step 2 CK Atlas ships one) that says which note each question tests.",
      });
      return;
    }
    contentEl.createEl("p", {
      cls: "fc-muted",
      text: "Type the numbers of the questions you missed in each block (e.g. 3, 7, 12-14). Only the numbers are saved; they point to the notes each question tests.",
    });
    new Setting(contentEl).setName("Exam").addDropdown((d) => {
      for (const e of exams) d.addOption(e.id, `${e.name}${SOURCE_NAMES[e.source] && !e.name.includes(SOURCE_NAMES[e.source]) ? ` (${SOURCE_NAMES[e.source]})` : ""}${this.plugin.exams.result(e.id) ? " ✓" : ""}`);
      d.setValue(this.exam?.id ?? exams[0].id).onChange((v) => {
        this.pick(v);
        this.render();
      });
    });
    const exam = this.exam;
    if (!exam) return;
    new Setting(contentEl).setName("Date taken").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(this.date).onChange((v) => (this.date = v || this.date));
    });
    const summary = contentEl.createDiv({ cls: "fc-muted fc-exam-summary" });
    const update = () => {
      const missed = this.missed();
      const items = Object.values(missed).reduce((n, l) => n + l.length, 0);
      const notes = new Set<string>();
      for (const b of exam.blocks) for (const n of missed[b.name] ?? []) for (const p of b.items[String(n)] ?? []) notes.add(p);
      const lost = unmappedItems(exam, missed);
      summary.setText(
        `${items} missed item${items === 1 ? "" : "s"} → ${notes.size} topic note${notes.size === 1 ? "" : "s"}` +
          (lost.length ? `. No note for: ${lost.slice(0, 8).join(", ")}${lost.length > 8 ? "…" : ""}` : "."),
      );
    };
    for (const b of exam.blocks) {
      const max = Math.max(0, ...Object.keys(b.items).map(Number));
      new Setting(contentEl)
        .setName(b.name)
        .setDesc(`Items 1–${max}`)
        .addText((t) => {
          t.setPlaceholder("e.g. 3, 7, 12-14").setValue(this.text[b.name] ?? "").onChange((v) => {
            this.text[b.name] = v;
            update();
          });
          t.inputEl.addClass("fc-exam-items");
        });
    }
    update();
    const saved = !!this.plugin.exams.result(exam.id);
    const bar = new Setting(contentEl);
    if (saved)
      bar.addButton((b) =>
        destructive(b).setButtonText("Delete saved result").onClick(async () => {
          await this.plugin.exams.remove(exam.id);
          new Notice(`Removed your ${exam.name} result (tags already added stay).`);
          this.pick(exam.id);
          this.render();
        }),
      );
    bar.addButton((b) =>
      b.setButtonText(saved ? "Update" : "Save").setCta().onClick(async () => {
        await this.plugin.exams.save({ examId: exam.id, date: this.date, missed: this.missed() });
        this.close();
        void this.plugin.openMisses();
      }),
    );
  }

  private missed(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const b of this.exam?.blocks ?? []) {
      const max = Math.max(0, ...Object.keys(b.items).map(Number));
      const list = parseItemList(this.text[b.name] ?? "").filter((n) => n >= 1 && (!max || n <= max));
      if (list.length) out[b.name] = list;
    }
    return out;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
