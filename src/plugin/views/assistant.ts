/**
 * AI helper: a side panel that follows the card under review. "Explain this card" gives the saved
 * explanation (asked once per card version), and a question box takes anything else about the card.
 * Answers are the model's own; the card's note is checked, not trusted (a conflict is pointed out),
 * and each answer links the student's notes worth opening. Nothing is sent until a button is pressed.
 */
import { Component, ItemView, MarkdownRenderer, Platform, TFile, type WorkspaceLeaf } from "obsidian";
import type { CardRef } from "../../core/collection";
import { cardFaces } from "../../core/faces";
import type FlashcardsPlugin from "../../main";
import { AiService, type AskTurn } from "../ai";
import type { ReviewContext } from "../api";

export const VIEW_AI = "flashcards-ai";

export class AssistantView extends ItemView {
  private component?: Component;
  private ref?: CardRef;
  private side: "front" | "back" = "front";
  private explanation: string | null = null;
  private thread: AskTurn[] = [];
  private busy = "";
  private error = "";
  private draft = "";

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: FlashcardsPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_AI;
  }

  getDisplayText(): string {
    return "AI helper";
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    const follow = (ctx: unknown) => this.setCard((ctx as ReviewContext).ref, (ctx as ReviewContext).side);
    this.registerEvent(this.plugin.api.on("cardShown", follow));
    this.registerEvent(this.plugin.api.on("answerShown", follow));
    this.registerEvent(this.plugin.api.on("sessionEnd", () => this.setCard(undefined, "front")));
    const now = this.plugin.reviewContext();
    this.setCard(now?.ref, now?.side ?? "front");
  }

  async onClose(): Promise<void> {
    this.component?.unload();
  }

  /** Follow the reviewer. A new card clears the thread; flipping the same card keeps it. */
  setCard(ref: CardRef | undefined, side: "front" | "back"): void {
    const same = !!ref && !!this.ref && ref.uid === this.ref.uid && ref.card.hash === this.ref.card.hash;
    this.ref = ref;
    this.side = side;
    if (!same) {
      this.explanation = null;
      this.thread = [];
      this.error = "";
      this.draft = "";
    }
    this.render();
    if (ref && !same) {
      void this.plugin.ai.savedExplanation(ref).then((saved) => {
        if (saved && this.ref === ref) {
          this.explanation = saved;
          this.render();
        }
      });
    }
  }

  private md(text: string, el: HTMLElement): void {
    void MarkdownRenderer.render(this.app, text, el, this.ref?.path ?? "", this.component!);
  }

  private async explain(): Promise<void> {
    const ref = this.ref;
    if (!ref || this.busy) return;
    this.busy = "Explaining…";
    this.error = "";
    this.render();
    const out = await this.plugin.ai.explain(ref);
    this.busy = "";
    if (this.ref !== ref) return;
    if (out) this.explanation = out;
    else this.error = "No explanation came back.";
    this.render();
  }

  private async ask(question: string): Promise<void> {
    const ref = this.ref;
    if (!ref || this.busy || !question.trim()) return;
    this.busy = "Thinking…";
    this.error = "";
    this.draft = "";
    this.render();
    try {
      const turn = await this.plugin.ai.ask(ref, question.trim(), this.thread);
      if (this.ref === ref) this.thread.push(turn);
    } catch (e) {
      if (this.ref === ref) {
        this.error = e instanceof Error ? e.message : String(e);
        this.draft = question;
      }
    }
    this.busy = "";
    if (this.ref === ref) this.render();
  }

  /** "In your notes: A · B": each opens beside the card, in the same pane every time. */
  private noteLinks(el: HTMLElement, paths: string[]): void {
    const files = paths.map((p) => this.app.vault.getFileByPath(p)).filter((f): f is TFile => !!f);
    if (!files.length) return;
    const row = el.createDiv({ cls: "fc-ai-notes" });
    row.createSpan({ cls: "fc-muted", text: "In your notes: " });
    files.forEach((f, i) => {
      if (i) row.createSpan({ cls: "fc-muted", text: " · " });
      const a = row.createEl("a", { text: f.basename, href: "#", cls: "fc-related-link" });
      a.onclick = (e) => {
        e.preventDefault();
        void this.openNote(f);
      };
    });
  }

  private noteLeaf?: WorkspaceLeaf;

  private async openNote(file: TFile): Promise<void> {
    const { workspace } = this.app;
    const reuse = this.noteLeaf && workspace.getLeavesOfType("markdown").includes(this.noteLeaf);
    this.noteLeaf = reuse ? this.noteLeaf! : workspace.getLeaf(Platform.isMobile ? "tab" : "split");
    await this.noteLeaf.openFile(file);
  }

  private render(): void {
    this.component?.unload();
    this.component = new Component();
    this.component.load();
    const el = this.contentEl;
    el.empty();
    el.addClass("fc-ai");
    el.createDiv({ cls: "fc-ai-title", text: "AI helper" });
    const ref = this.ref;
    if (!ref) {
      el.createDiv({ cls: "fc-muted", text: "Start studying a deck. This panel follows the card you are on." });
      return;
    }
    const blocked = this.plugin.ai.blockedReason(ref);
    if (blocked) {
      el.createDiv({ cls: "fc-muted", text: blocked });
      return;
    }
    const faces = cardFaces(ref.card, ref.slot);
    el.createDiv({ cls: "fc-ai-card fc-muted", text: faces.question.replace(/!\[\[[^\]]*\]\]/g, "").replace(/<[^>]+>/g, "").replace(/\*\*|__/g, "").replace(/(^|[\s(])[*_](?=\S)/g, "$1").replace(/(\S)[*_](?=[\s.,;:)]|$)/g, "$1").slice(0, 200) });
    if (this.side === "front") {
      el.createDiv({ cls: "fc-muted", text: "Show the answer first. The helper would give it away." });
      return;
    }
    if (this.explanation) {
      el.createDiv({ cls: "fc-ai-question", text: "Explain this card" });
      const saved = AiService.splitExplanation(this.explanation);
      this.md(saved.text, el.createDiv({ cls: "fc-ai-answer" }));
      // Notes the student linked or the card names, then the ones the model picked as relevant.
      const sure = this.plugin.relatedFor(ref).map((f) => f.path);
      this.noteLinks(el, [...sure, ...saved.notes.filter((n) => !sure.includes(n))]);
    } else {
      const b = el.createEl("button", { text: "Explain this card", cls: "mod-cta" });
      if (this.busy) b.setAttr("disabled", "true");
      b.onclick = () => void this.explain();
    }
    for (const t of this.thread) {
      el.createDiv({ cls: "fc-ai-question", text: t.question });
      this.md(t.answer, el.createDiv({ cls: "fc-ai-answer" }));
      if (t.noteIssue) {
        const warn = el.createDiv({ cls: "fc-ai-note-issue" });
        warn.createSpan({ cls: "fc-ai-note-issue-label", text: "Check your note: " });
        warn.createSpan({ text: t.noteIssue });
      }
      this.noteLinks(el, t.notes);
    }
    if (this.busy) el.createDiv({ cls: "fc-muted fc-ai-busy", text: this.busy });
    if (this.error) el.createDiv({ cls: "fc-ai-error", text: this.error });
    const form = el.createDiv({ cls: "fc-ai-form" });
    form.createDiv({ cls: "fc-ai-caution fc-muted", text: "AI answers can be wrong. Check anything you will rely on." });
    const input = form.createEl("textarea", { attr: { rows: "2", placeholder: "Ask about this card…" } });
    input.value = this.draft;
    input.oninput = () => (this.draft = input.value);
    const send = form.createEl("button", { text: "Ask" });
    if (this.busy) send.setAttr("disabled", "true");
    send.onclick = () => void this.ask(input.value);
    // After an answer arrives, bring it into view (the box below stays pinned).
    if (this.thread.length || this.busy) el.scrollTop = el.scrollHeight;
    input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // typing here must not grade the card
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.ask(input.value);
      }
    });
  }
}
