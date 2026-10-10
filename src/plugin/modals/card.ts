/** Per-card dialogs: edit, card info, set due date (spec 0003 §3, §6). */
import { App, Modal, Notice, Setting } from "obsidian";
import { State } from "ts-fsrs";
import type { CardRef } from "../../core/collection";
import { parseDueInput } from "../../core/due";
import type { LogEvent } from "../../core/log";
import { formatInterval } from "../../core/scheduler";
import type { CardState } from "../../core/state";
import type FlashcardsPlugin from "../../main";

/** Edit a card's source lines without leaving the review (Anki's "Edit"). */
export class EditCardModal extends Modal {
  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    private ref: CardRef,
    private onSaved: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Edit card");
    const { contentEl } = this;
    contentEl.createDiv({ cls: "setting-item-description", text: `${this.ref.path}, line ${this.ref.card.startLine + 1}` });
    const ta = contentEl.createEl("textarea", { cls: "fc-edit-area" });
    ta.value = this.ref.card.sourceLines.join("\n");
    ta.rows = Math.min(16, Math.max(4, this.ref.card.sourceLines.length + 2));
    const save = async () => {
      const ok = await this.plugin.editCard(this.ref, ta.value);
      if (!ok) {
        new Notice("The note changed since this card was shown; reopen the card and try again.");
        return;
      }
      this.close();
      this.onSaved();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void save();
      }
    });
    new Setting(contentEl)
      .setDesc("⌘/Ctrl+Enter to save. Keep the ^fc-… tag at the end so the card keeps its history.")
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Save").setCta().onClick(() => void save()));
    window.setTimeout(() => ta.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

const STATE_NAME: Record<number, string> = {
  [State.New]: "New",
  [State.Learning]: "Learning",
  [State.Review]: "Review",
  [State.Relearning]: "Relearning",
};

function fmtDate(d: Date | string | undefined): string {
  if (!d) return "—";
  const x = typeof d === "string" ? new Date(d) : d;
  return x.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Anki's Card Info, plus which device each review was done on. */
export class CardInfoModal extends Modal {
  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    private ref: CardRef,
    private state: CardState | undefined,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Card info");
    const { contentEl } = this;
    const s = this.state;
    const c = s?.card;
    const now = new Date();
    const rows: Array<[string, string]> = [
      ["Deck", this.ref.deck.split("/").join(" › ")],
      ["Note", `${this.ref.path}, line ${this.ref.card.startLine + 1}`],
      ["Card", this.ref.key ?? "new (no ID yet)"],
      ["State", c ? STATE_NAME[c.state] : "New"],
      ["First review", fmtDate(s?.reviews[0]?.ts)],
      ["Latest review", fmtDate(s?.reviews[s.reviews.length - 1]?.ts)],
      ["Due", c && c.state !== State.New ? fmtDate(c.due) : "—"],
      ["Interval", c && c.state !== State.New ? formatInterval(c.due.getTime() - (c.last_review?.getTime() ?? now.getTime())) : "—"],
      ["Stability", c && c.state !== State.New ? `${c.stability.toFixed(1)} days` : "—"],
      ["Difficulty", c && c.state !== State.New ? `${((c.difficulty / 10) * 100).toFixed(0)}%` : "—"],
      [
        "Retrievability",
        c && c.state !== State.New ? `${(this.plugin.schedulerFor(this.ref).get_retrievability(c, now, false) * 100).toFixed(0)}%` : "—",
      ],
      ["Reviews", String(s?.reviews.length ?? 0)],
      ["Lapses", String(c?.lapses ?? 0)],
      [
        "Average time",
        s?.reviews.length ? `${(s.reviews.reduce((a, r) => a + r.ms, 0) / s.reviews.length / 1000).toFixed(1)}s` : "—",
      ],
    ];
    if (s?.suspended) rows.push(["Suspended", "yes"]);
    const table = contentEl.createEl("table", { cls: "fc-info-table" });
    for (const [k, v] of rows) {
      const tr = table.createEl("tr");
      tr.createEl("th", { text: k });
      tr.createEl("td", { text: v });
    }
    if (s?.reviews.length) {
      contentEl.createEl("h4", { text: "History" });
      const h = contentEl.createEl("table", { cls: "fc-info-history" });
      const head = h.createEl("tr");
      for (const col of ["Date", "Type", "Rating", "Interval", "Time", "Device"]) head.createEl("th", { text: col });
      for (const r of [...s.reviews].reverse()) {
        const tr = h.createEl("tr");
        tr.createEl("td", { text: fmtDate(r.ts) });
        tr.createEl("td", { text: STATE_NAME[r.stateBefore] === "New" ? "Learn" : STATE_NAME[r.stateBefore] });
        tr.createEl("td", { text: r.rating[0].toUpperCase() + r.rating.slice(1), cls: `fc-${r.rating}` });
        tr.createEl("td", { text: formatInterval(r.due.getTime() - Date.parse(r.ts)) });
        tr.createEl("td", { text: `${(r.ms / 1000).toFixed(1)}s` });
        tr.createEl("td", { text: r.device ?? "" });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Anki's Set Due Date: 0 = today, 3 = in 3 days, 3-7 = random day in range. */
export class SetDueModal extends Modal {
  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    private refs: CardRef[],
    private onDone: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.refs.length === 1 ? "Set due date" : `Set due date (${this.refs.length} cards)`);
    const { contentEl } = this;
    let value = "";
    const apply = async () => {
      const now = Date.now();
      if (!parseDueInput(value, now, this.plugin.settings.dayStartHour)) {
        new Notice("Enter 0 (today), a number of days, or a range like 3-7.");
        return;
      }
      const events: LogEvent[] = [];
      const ordered = [...this.refs].sort((a, b) => a.path.localeCompare(b.path) || b.card.startLine - a.card.startLine);
      for (const ref of ordered) {
        const due = parseDueInput(value, now, this.plugin.settings.dayStartHour)!;
        const key = await this.plugin.ensureKey(ref);
        if (!key) continue;
        events.push({ ts: new Date(now + events.length).toISOString(), type: "reschedule", key, due: due.toISOString() });
      }
      await this.plugin.logEvents(events);
      this.close();
      this.onDone();
    };
    new Setting(contentEl)
      .setName("Show in how many days?")
      .setDesc("0 = today, 1 = tomorrow, 3-7 = a random day in that range.")
      .addText((t) => {
        t.setPlaceholder("0").onChange((v) => (value = v));
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void apply();
          }
        });
        window.setTimeout(() => t.inputEl.focus(), 0);
      });
    new Setting(contentEl).addButton((b) => b.setButtonText("Set").setCta().onClick(() => void apply()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
