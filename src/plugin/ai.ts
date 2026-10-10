/**
 * Optional AI helpers (spec 0005 §3), using the owner's own API key for the provider they pick
 * (Anthropic through its SDK; OpenAI, Gemini, OpenRouter or any OpenAI-compatible server otherwise):
 *  1. find hard terms on cards and write short definitions (cached per device in the vault,
 *     append-only, like the review log, so iCloud never merges a shared file);
 *  2. suggest how to split an overstuffed card into a short front and a back.
 * Never runs during review; nothing is written to a note without the owner's confirmation.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { App, Modal, normalizePath, Notice, requestUrl, Setting, TFile } from "obsidian";
import { z } from "zod";
import type { CardRef } from "../core/collection";
import { cardFaces } from "../core/faces";
import { linesFromBatch, planBatch, type BatchResult } from "../core/ai-batch";
import { AI_PROVIDERS, aiKeyId, chatBody, chatJson, chatUrl } from "../core/ai-providers";
import { formatAiCard, formatAiTerm, parseAiGlossary } from "../core/terms";
import type FlashcardsPlugin from "../main";
import { getSecret, pullKeyFile } from "./secrets";


const BATCH = 10;
const AUTO_LIMIT = 30;
/** From this many cards, offer the Message Batches API (half price, results within 24 hours). */
const BATCH_SUGGEST = 300;
/** Off for 1.0: batch mode has never run against the live service. Turn on once it has. */
const BATCH_OFFERED = false;

/** A submitted batch, saved in the vault so results are collected after a restart or on another device. */
interface PendingBatch {
  id: string;
  model: string;
  created: string;
  cards: Record<string, string[]>;
}

/** Rough per-card cost in USD (about 400 input + 200 output tokens), for the confirm dialog. */
const PER_CARD: Record<string, number> = {
  "claude-opus-5": 0.007,
  "claude-sonnet-5": 0.0028,
  "claude-haiku-4-5": 0.0014,
};

const TermsSchema = z.object({
  cards: z.array(
    z.object({
      id: z.string(),
      terms: z.array(z.object({ term: z.string(), definition: z.string() })),
    }),
  ),
});

const ExplainSchema = z.object({ explanation: z.string(), hook: z.string(), relevant_notes: z.array(z.string()) });

/** Saved after an explanation: the notes the model judged worth opening (paths, one per line). */
const NOTES_MARK = "\n<!--notes\n";

const AskSchema = z.object({ answer: z.string(), note_issue: z.string(), relevant_notes: z.array(z.string()) });

const ASK_SYSTEM = [
  "A student is reviewing one flashcard and asks a question about it.",
  "answer: reply directly, in your own words and from well-established knowledge, in at most 120 words of plain Markdown (short lists are fine, no headings). If you are not sure, say so instead of guessing.",
  "You are also given the part of the student's own note the card was written in. It is context, not a source: it may contain mistakes, so never repeat a claim just because the note makes it.",
  "note_issue: if that note says something that conflicts with well-established facts and matters for this card or question, say in at most 40 words what the note says and what is correct. Otherwise an empty string. Do not flag wording, omissions or style.",
  "relevant_notes: from the list of the student's note titles, the ones worth opening for this question, copied exactly. An empty list if none fit.",
].join(" ");

/** One exchange in the AI helper panel. */
export interface AskTurn {
  question: string;
  answer: string;
  /** Where the student's note disagrees with the facts, if it does. */
  noteIssue: string;
  /** Paths of the student's notes worth opening for this question. */
  notes: string[];
}

const EXPLAIN_SYSTEM = [
  "A medical student keeps missing this flashcard. Help it stick.",
  "explanation: in at most 60 words and plain language, say why the answer is what it is (the mechanism, anatomy or reasoning).",
  "hook: one short memory aid of at most 25 words (a mnemonic, a picture to imagine, or a contrast with the thing it is confused with).",
  "Use only well-established facts and stay within what the card says; if the card is ambiguous or you are not sure, say so instead of guessing.",
  "Plain Markdown, no headings.",
  "relevant_notes: you are also given titles of the student's own notes, found by a rough word match, so many will be off topic. Copy exactly the titles that are truly about this card's subject; an empty list if none are.",
].join(" ");

const SplitSchema = z.object({
  front: z.string(),
  back: z.array(z.string()),
});

const TERMS_SYSTEM = [
  "You help a final-year medical student headed into orthopaedic surgery who studies from flashcards.",
  "For each card, list the terms a student could plausibly not know or mix up: eponyms, abbreviations,",
  "classification systems, uncommon anatomical, radiological or clinical terms, and drug names.",
  "Skip everyday words and terms every medical student knows well (for example: fracture, artery, femur, pain).",
  "Only list terms that appear in the card text, spelled as they appear. Give each a plain, accurate,",
  "neutral definition of one or two sentences (at most 40 words). If a card has no such terms, return an empty list.",
].join(" ");

const SPLIT_SYSTEM = [
  "You rewrite overstuffed flashcards for a medical student. Keep every fact; add none.",
  "Return a short declarative front of about 10-15 words stating one fact, with exactly one ==cloze== around",
  "the key answer (1-4 words). Move the explanation and any extra detail into 1-4 short back lines.",
  "Keep the student's wording where possible. Plain Markdown only; keep any [[links]] or ![[images]] unchanged.",
].join(" ");

export class AiService {
  private running = false;
  private lastStatus = "";

  constructor(private plugin: FlashcardsPlugin) {}

  private get app(): App {
    return this.plugin.app;
  }

  private get keyId(): string {
    return aiKeyId(this.plugin.settings.ai.provider);
  }

  private get isAnthropic(): boolean {
    return this.plugin.settings.ai.provider === "anthropic";
  }

  /** The model in use, as the provider names it. */
  private get modelName(): string {
    const ai = this.plugin.settings.ai;
    return this.isAnthropic ? ai.model : ai.otherModel.trim();
  }

  /** Ready to call: a key (a local "custom" server needs none), and for other providers a model and address. */
  hasKey(): boolean {
    const ai = this.plugin.settings.ai;
    if (this.isAnthropic) return !!getSecret(this.app, this.keyId);
    if (!this.modelName || !chatUrl(ai.provider, ai.baseUrl)) return false;
    return ai.provider === "custom" || !!getSecret(this.app, this.keyId);
  }

  /** With key syncing on, take the key another device saved (it may arrive after startup). */
  async pullKey(): Promise<void> {
    if (!this.plugin.settings.ai.syncKey) return;
    await pullKeyFile(this.app, this.plugin.manifest.dir ?? "", this.keyId);
  }

  private client(): Anthropic {
    // The key belongs to the owner and stays on this device; Obsidian runs in a browser engine.
    return new Anthropic({ apiKey: getSecret(this.app, this.keyId), dangerouslyAllowBrowser: true, maxRetries: 2 });
  }

  /** Model-specific request options: Opus 5 gets server-side refusal fallbacks and low effort. */
  private modelParams(): Record<string, unknown> {
    const model = this.plugin.settings.ai.model;
    if (model === "claude-opus-5") return { model, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", effort: "low" };
    if (model === "claude-sonnet-5") return { model, effort: "low" };
    return { model };
  }

  /** One request to an OpenAI-compatible provider; the reply is checked against the same schema. */
  private async callChat<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T> {
    const ai = this.plugin.settings.ai;
    const key = getSecret(this.app, this.keyId);
    const res = await requestUrl({
      url: chatUrl(ai.provider, ai.baseUrl),
      method: "POST",
      contentType: "application/json",
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: JSON.stringify(chatBody(this.modelName, system, user, z.toJSONSchema(schema))),
      throw: false,
    });
    if (res.status === 401 || res.status === 403) throw new Error("the API key was rejected.");
    if (res.status === 429) throw new Error("rate limited; try again in a minute.");
    if (res.status < 200 || res.status >= 300) {
      let msg = "";
      try {
        msg = (res.json as { error?: { message?: string } })?.error?.message ?? "";
      } catch {
        // not JSON
      }
      throw new Error(`API error ${res.status} ${msg}`.trim());
    }
    const parsed = schema.safeParse(chatJson(res.json));
    if (!parsed.success) throw new Error("The reply couldn't be read.");
    return parsed.data;
  }

  private async call<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T> {
    if (!this.isAnthropic) return this.callChat(system, user, schema);
    const format = betaZodOutputFormat(schema);
    const p = this.modelParams();
    const { effort, ...rest } = p as { effort?: string; model: string };
    let res;
    try {
      res = await this.client().beta.messages.parse({
        ...(rest as { model: string }),
        max_tokens: 8000,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format, ...(effort ? { effort: effort as "low" } : {}) },
      });
    } catch (e) {
      // parse() throws before we see stop_reason when the reply was cut off or declined.
      if (e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError)) {
        throw new Error("The reply couldn't be read (it may have been cut off or declined).");
      }
      throw e;
    }
    if (res.stop_reason === "refusal") throw new Error("The model declined this request.");
    if (res.stop_reason === "max_tokens") throw new Error("The reply was cut off (too long).");
    if (!res.parsed_output) throw new Error("The reply couldn't be read.");
    return res.parsed_output as T;
  }

  // ---- the glossary files ---------------------------------------------------------------------

  private get ownFile(): string {
    return normalizePath(`${this.plugin.terms.aiFolder}/${this.plugin.logs.device}.md`);
  }

  private async glossaryTexts(): Promise<string[]> {
    const out: string[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path.startsWith(this.plugin.terms.aiFolder + "/")) out.push(await this.app.vault.cachedRead(f));
    }
    return out;
  }

  private async append(lines: string[]): Promise<void> {
    if (!lines.length) return;
    const { vault } = this.app;
    let dir = "";
    for (const part of this.plugin.terms.aiFolder.split("/")) {
      dir = dir ? `${dir}/${part}` : part;
      if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir).catch(() => undefined);
    }
    const text = lines.join("\n") + "\n";
    const existing = vault.getAbstractFileByPath(this.ownFile);
    if (existing instanceof TFile) await vault.append(existing, text);
    else await vault.create(this.ownFile, `# fc-ai-glossary v1 · device ${this.plugin.logs.device} · do not edit by hand\n\n${text}`);
  }

  /** Cards (one per note block) not yet looked at, outside excluded folders. */
  async pendingCards(): Promise<CardRef[]> {
    const done = parseAiGlossary(await this.glossaryTexts()).cards;
    for (const b of await this.pendingBatches()) for (const hs of Object.values(b.batch.cards)) for (const h of hs) done.add(h);
    const excluded = this.plugin.settings.ai.excludeFolders;
    const seen = new Set<string>();
    const out: CardRef[] = [];
    for (const ref of this.plugin.index.refs()) {
      if (ref.card.type === "occlusion") continue;
      if (excluded.some((f) => ref.path.startsWith(f + "/"))) continue;
      const h = ref.card.hash;
      if (done.has(h) || seen.has(h)) continue;
      seen.add(h);
      out.push(ref);
    }
    return out;
  }

  statusText(): string {
    if (!this.hasKey()) return this.isAnthropic ? "Add an API key first." : "Add an API key and a model name first.";
    return this.lastStatus || "Looks at cards not seen before and adds definitions for hard terms.";
  }

  // ---- finding terms ----------------------------------------------------------------------------

  private cardText(ref: CardRef): string {
    const f = cardFaces(ref.card, ref.slot);
    const answer = f.kind === "cloze" ? f.answer.replace(/==/g, "") : `${f.question} — ${f.answer}`;
    return `${answer}${f.extra ? `\n${f.extra}` : ""}`.replace(/!\[\[[^\]]*\]\]/g, "").slice(0, 1200);
  }

  private async process(cards: CardRef[]): Promise<number> {
    const model = this.modelName;
    const date = new Date().toISOString().slice(0, 10);
    let found = 0;
    for (let i = 0; i < cards.length; i += BATCH) {
      const batch = cards.slice(i, i + BATCH);
      const user = batch.map((r) => `<card id="${r.card.hash}">\n${this.cardText(r)}\n</card>`).join("\n");
      const out = await this.call(TERMS_SYSTEM, `Cards:\n${user}`, TermsSchema);
      const lines: string[] = [];
      for (const c of out.cards) {
        for (const t of c.terms) {
          if (!t.term.trim() || !t.definition.trim()) continue;
          lines.push(formatAiTerm(t.term, t.definition, model, date));
          found++;
        }
      }
      // Mark every card in the batch as looked at, even those with no hard terms.
      for (const r of batch) lines.push(formatAiCard(r.card.hash));
      await this.append(lines);
    }
    return found;
  }

  /** Background pass for a few new cards (never a large, costly run without asking). */
  async autoRun(): Promise<void> {
    await this.pullKey();
    const s = this.plugin.settings.ai;
    if (s.enabled && this.isAnthropic && this.hasKey()) await this.collectBatches().catch((e) => console.error("Flashcards: collecting AI batches failed", e));
    if (!s.enabled || !s.autoRun || !this.hasKey() || this.running) return;
    const pending = await this.pendingCards();
    if (!pending.length || pending.length > AUTO_LIMIT) {
      if (pending.length > AUTO_LIMIT) this.lastStatus = `${pending.length} cards not looked at yet. Press Run to process them.`;
      return;
    }
    await this.run(pending, false);
  }

  async runWithConfirm(): Promise<void> {
    if (!this.hasKey()) {
      new Notice("Add your API key in Osteon settings first.");
      return;
    }
    if (!this.plugin.settings.ai.enabled) {
      new Notice("Turn on “Use AI” in Osteon settings first.");
      return;
    }
    const pending = await this.pendingCards();
    if (!pending.length) {
      new Notice("Every card has already been looked at.");
      return;
    }
    const cost = (PER_CARD[this.plugin.settings.ai.model] ?? 0.007) * pending.length;
    const usd = (x: number) => `$${x < 0.01 ? "0.01" : x.toFixed(2)}`;
    const big = BATCH_OFFERED && this.isAnthropic && pending.length >= BATCH_SUGGEST;
    const where = AI_PROVIDERS[this.plugin.settings.ai.provider].label;
    new ConfirmModal(
      this.app,
      `Look at ${pending.length} card${pending.length === 1 ? "" : "s"}?`,
      (this.isAnthropic
        ? `This sends their text to Anthropic's API using ${this.modelName}. Estimated cost: about ${usd(cost)} (billed to your API account). `
        : `This sends their text to ${where} using ${this.modelName}. The cost depends on that provider and model. `) +
        "Each card is only ever looked at once." +
        (big ? ` For a run this size, Batch costs about half (${usd(cost / 2)}) and the definitions arrive within 24 hours (usually under one); they're collected automatically.` : ""),
      () => void this.run(pending, true),
      big ? { label: "Batch (half price)", onClick: () => void this.submitBatch(pending) } : undefined,
    ).open();
  }

  private async run(cards: CardRef[], manual: boolean): Promise<void> {
    if (this.running) return;
    this.running = true;
    const notice = manual ? new Notice(`Looking at ${cards.length} cards…`, 0) : null;
    try {
      const found = await this.process(cards);
      this.lastStatus = `Last run: ${cards.length} cards, ${found} term definitions added.`;
      await this.plugin.terms.rebuild();
      if (manual) new Notice(this.lastStatus);
    } catch (e) {
      this.lastStatus = `Last run failed: ${describe(e)}`;
      console.error("Flashcards: AI term pass failed", e);
      if (manual) new Notice(this.lastStatus, 10000);
    } finally {
      notice?.hide();
      this.running = false;
    }
  }

  // ---- batch mode (big first runs) ---------------------------------------------------------------

  private get batchFolder(): string {
    return normalizePath(`${this.plugin.terms.aiFolder}/batches`);
  }

  private async pendingBatches(): Promise<Array<{ path: string; batch: PendingBatch }>> {
    const { adapter } = this.app.vault;
    if (!(await adapter.exists(this.batchFolder))) return [];
    const out: Array<{ path: string; batch: PendingBatch }> = [];
    for (const f of (await adapter.list(this.batchFolder)).files.filter((x) => x.endsWith(".json"))) {
      try {
        out.push({ path: f, batch: JSON.parse(await adapter.read(f)) as PendingBatch });
      } catch {
        // A half-synced file: try again next time.
      }
    }
    return out;
  }

  /** Send every card in one Message Batches submission; results are collected by `collectBatches`. */
  async submitBatch(cards: CardRef[]): Promise<void> {
    if (this.running) return;
    this.running = true;
    const notice = new Notice(`Sending ${cards.length} cards as a batch…`, 0);
    try {
      const model = this.plugin.settings.ai.model;
      const plan = planBatch(cards.map((r) => ({ hash: r.card.hash, text: this.cardText(r) })), BATCH);
      // The structured-output schema as plain JSON (the helper object also carries a parser).
      const format = JSON.parse(JSON.stringify(betaZodOutputFormat(TermsSchema))) as Record<string, unknown>;
      const effort = model === "claude-haiku-4-5" ? undefined : "low";
      const batch = await this.client().beta.messages.batches.create({
        requests: plan.requests.map((r) => ({
          custom_id: r.customId,
          params: {
            model,
            max_tokens: 8000,
            system: TERMS_SYSTEM,
            messages: [{ role: "user", content: r.user }],
            output_config: { format, ...(effort ? { effort } : {}) },
          } as never,
        })),
      });
      const { adapter } = this.app.vault;
      if (!(await adapter.exists(this.batchFolder))) await this.app.vault.createFolder(this.batchFolder).catch(() => undefined);
      const record: PendingBatch = { id: batch.id, model, created: new Date().toISOString(), cards: plan.cards };
      await adapter.write(normalizePath(`${this.batchFolder}/${batch.id}.json`), JSON.stringify(record));
      this.lastStatus = `Batch sent: ${cards.length} cards in ${plan.requests.length} requests. Definitions are added automatically when it finishes (within 24 hours).`;
      new Notice(this.lastStatus, 10000);
    } catch (e) {
      this.lastStatus = `Batch couldn't be sent: ${describe(e)}`;
      console.error("Flashcards: AI batch submit failed", e);
      new Notice(this.lastStatus, 10000);
    } finally {
      notice.hide();
      this.running = false;
    }
  }

  /** Collect finished batches: write their definitions, mark their cards, forget the batch. */
  async collectBatches(): Promise<void> {
    const pending = await this.pendingBatches();
    if (!pending.length) return;
    const client = this.client();
    const date = new Date().toISOString().slice(0, 10);
    for (const { path, batch } of pending) {
      const info = await client.beta.messages.batches.retrieve(batch.id);
      if (info.processing_status !== "ended") continue;
      const results: BatchResult[] = [];
      for await (const item of await client.beta.messages.batches.results(batch.id)) {
        const r = item.result;
        if (r.type !== "succeeded" || r.message.stop_reason === "refusal" || r.message.stop_reason === "max_tokens") {
          results.push({ customId: item.custom_id });
          continue;
        }
        const text = r.message.content.find((b) => b.type === "text");
        results.push({ customId: item.custom_id, json: text && "text" in text ? text.text : undefined });
      }
      const out = linesFromBatch(results, batch.cards, batch.model, date);
      await this.append(out.lines);
      await this.app.vault.adapter.remove(path);
      this.lastStatus =
        `Batch finished: ${out.cardsDone} cards, ${out.terms} term definitions added` +
        (out.failedRequests ? `; ${out.failedRequests} requests failed and those cards will be retried on the next run.` : ".");
      new Notice(this.lastStatus, 10000);
      await this.plugin.terms.rebuild();
    }
  }

  // ---- explaining a card that keeps being missed (Weak spots) ---------------------------------

  private get explainFile(): string {
    return normalizePath(`${this.plugin.terms.aiFolder}/explanations-${this.plugin.logs.device}.json`);
  }

  private explanations?: Map<string, string>;

  /** Saved explanations from every device (each device writes only its own file). */
  private async loadExplanations(): Promise<Map<string, string>> {
    if (this.explanations) return this.explanations;
    const map = new Map<string, string>();
    const adapter = this.app.vault.adapter;
    try {
      const folder = normalizePath(this.plugin.terms.aiFolder);
      const files = (await adapter.exists(folder)) ? (await adapter.list(folder)).files : [];
      for (const f of files) {
        if (!/\/explanations-[^/]+\.json$/.test(f)) continue;
        try {
          for (const [k, v] of Object.entries(JSON.parse(await adapter.read(f)) as Record<string, string>)) if (typeof v === "string") map.set(k, v);
        } catch {
          // An unreadable file (mid-sync) only means those explanations are asked for again.
        }
      }
    } catch {
      // No folder yet.
    }
    return (this.explanations = map);
  }

  /** The saved explanation for this version of the card, if there is one (no API call). */
  async savedExplanation(ref: CardRef): Promise<string | undefined> {
    return (await this.loadExplanations()).get(`${ref.uid}|${ref.card.hash}`);
  }

  /** Why the answer is what it is, plus a memory hook. Asked once per card version, then saved. */
  async explain(ref: CardRef): Promise<string | null> {
    const saved = await this.savedExplanation(ref);
    if (saved) return saved;
    await this.pullKey();
    if (!this.hasKey() || !this.plugin.settings.ai.enabled) {
      new Notice("Turn on AI and add an API key in Osteon settings to get explanations.");
      return null;
    }
    if (this.plugin.settings.ai.excludeFolders.some((f) => ref.path.startsWith(f + "/"))) {
      new Notice("This card is in a folder that's never sent to the API.");
      return null;
    }
    try {
      const candidates = this.noteCandidates(ref);
      const titles = candidates.map((f) => `- ${f.basename}`).join("\n") || "(none)";
      const out = await this.call(EXPLAIN_SYSTEM, `Card:\n${this.cardText(ref)}\n\nThe student's note titles:\n${titles}`, ExplainSchema);
      const picked = new Set(out.relevant_notes.map((t) => t.trim().toLowerCase()));
      const notes = candidates.filter((f) => picked.has(f.basename.toLowerCase())).map((f) => f.path);
      const text = `${out.explanation.trim()}\n\n**Hook:** ${out.hook.trim()}${notes.length ? `${NOTES_MARK}${notes.join("\n")}\n-->` : ""}`;
      const map = await this.loadExplanations();
      map.set(`${ref.uid}|${ref.card.hash}`, text);
      const adapter = this.app.vault.adapter;
      let own: Record<string, string> = {};
      try {
        if (await adapter.exists(this.explainFile)) own = JSON.parse(await adapter.read(this.explainFile)) as Record<string, string>;
      } catch {
        own = {};
      }
      own[`${ref.uid}|${ref.card.hash}`] = text;
      const folder = normalizePath(this.plugin.terms.aiFolder);
      if (!(await adapter.exists(folder))) await this.app.vault.createFolder(folder).catch(() => undefined);
      await adapter.write(this.explainFile, JSON.stringify(own, null, 1));
      return text;
    } catch (e) {
      new Notice(`Explanation failed: ${describe(e)}`, 8000);
      return null;
    }
  }

  /** Whether the helpers can run for this card right now; a short reason when they can't. */
  blockedReason(ref: CardRef): string | null {
    const ai = this.plugin.settings.ai;
    if (!ai.enabled || !this.hasKey()) return "Turn on AI and add an API key in Osteon settings to use the helper.";
    if (ai.excludeFolders.some((f) => ref.path.startsWith(f + "/"))) return "This card is in a folder that's never sent to the AI provider.";
    return null;
  }

  /** The lines of the card's note around the card, so answers can lean on the student's own note. */
  private async noteAround(ref: CardRef): Promise<string> {
    const file = this.app.vault.getFileByPath(ref.path);
    if (!file) return "";
    const lines = (await this.app.vault.cachedRead(file)).split("\n");
    const from = Math.max(0, ref.card.startLine - 25);
    const to = Math.min(lines.length, ref.card.endLine + 26);
    return lines
      .slice(from, to)
      .join("\n")
      .replace(/!\[\[[^\]]*\]\]/g, "")
      .replace(/\s\^fc-[a-z0-9]{8}/g, "")
      .slice(0, 3000);
  }

  /**
   * The student's notes that could matter for a card or a question about it: the card's own note
   * (not for imported decks, whose notes are only card storage), the notes the card is linked to
   * or mentions, and notes the question itself names.
   */
  noteCandidates(ref: CardRef, question = ""): TFile[] {
    const out: TFile[] = [];
    const add = (f: TFile | null | undefined) => {
      if (f && !out.some((x) => x.path === f.path)) out.push(f);
    };
    const own = this.app.vault.getFileByPath(ref.path);
    if (own && !this.app.metadataCache.getFileCache(own)?.frontmatter?.["anki-deck"]) add(own);
    for (const f of this.plugin.relatedFor(ref)) add(f);
    if (question) for (const f of this.plugin.terms.relatedNotes(question, [ref.path, ...out.map((f) => f.path)], 3)) add(f);
    // Then notes whose titles share a distinctive word with the card's own sentence or the question
    // (the long Extra of an imported card names too many things in passing).
    for (const f of this.plugin.noteMatches(`${ref.card.front}\n${ref.card.answer}\n${question}`, 4)) add(f);
    return out.slice(0, 8);
  }

  /** A free question about one card (the side panel). Not saved; `history` carries earlier turns. */
  async ask(ref: CardRef, question: string, history: AskTurn[]): Promise<AskTurn> {
    await this.pullKey();
    const blocked = this.blockedReason(ref);
    if (blocked) throw new Error(blocked);
    const candidates = this.noteCandidates(ref, question);
    const earlier = history.map((t) => `Earlier question: ${t.question}\nEarlier answer: ${t.answer}`).join("\n\n");
    const user = [
      `Card:\n${this.cardText(ref)}`,
      `From the student's note (may contain mistakes):\n${await this.noteAround(ref)}`,
      `The student's note titles:\n${candidates.map((f) => `- ${f.basename}`).join("\n") || "(none)"}`,
      earlier,
      `Question: ${question}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      const out = await this.call(ASK_SYSTEM, user, AskSchema);
      const picked = new Set(out.relevant_notes.map((t) => t.trim().toLowerCase()));
      return {
        question,
        answer: out.answer.trim(),
        noteIssue: out.note_issue.trim(),
        notes: candidates.filter((f) => picked.has(f.basename.toLowerCase())).map((f) => f.path),
      };
    } catch (e) {
      throw new Error(describe(e));
    }
  }

  /** A saved explanation split into its text and the notes the model picked for it. */
  static splitExplanation(saved: string): { text: string; notes: string[] } {
    const at = saved.indexOf(NOTES_MARK);
    if (at < 0) return { text: saved, notes: [] };
    return { text: saved.slice(0, at), notes: saved.slice(at + NOTES_MARK.length).replace(/\n?-->\s*$/, "").split("\n").filter(Boolean) };
  }

  // ---- splitting an overstuffed card ------------------------------------------------------------

  async suggestSplit(ref: CardRef): Promise<{ front: string; back: string[] } | null> {
    await this.pullKey();
    if (!this.hasKey() || !this.plugin.settings.ai.enabled) {
      new Notice("Turn on AI and add an API key in Osteon settings to get suggestions.");
      return null;
    }
    const excluded = this.plugin.settings.ai.excludeFolders;
    if (excluded.some((f) => ref.path.startsWith(f + "/"))) {
      new Notice("This card is in a folder that's never sent to the API.");
      return null;
    }
    const src = ref.card.sourceLines
      .join("\n")
      .replace(/\s\^fc-[a-z0-9]{8}/g, "")
      .replace(/<!--SR:.*?-->/g, "");
    try {
      const out = await this.call(SPLIT_SYSTEM, `Card:\n${src}`, SplitSchema);
      // It must still be a card: a non-empty front with exactly one ==cloze== (for cloze cards).
      const clozes = out.front.match(/==[^=]+==/g) ?? [];
      if (!out.front.trim() || (ref.card.type === "cloze" && clozes.length !== 1)) {
        new Notice("The suggestion didn't keep exactly one cloze, so it isn't offered. Try again or rewrite by hand.", 8000);
        return null;
      }
      return out;
    } catch (e) {
      new Notice(`Suggestion failed: ${describe(e)}`, 8000);
      return null;
    }
  }
}

function describe(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "the API key was rejected.";
  if (e instanceof Anthropic.RateLimitError) return "rate limited; try again in a minute.";
  if (e instanceof Anthropic.APIConnectionError) return "no connection to the AI provider.";
  if (e instanceof Anthropic.APIError) return `API error ${e.status ?? ""} ${e.message}`.trim();
  return e instanceof Error ? e.message : String(e);
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private heading: string,
    private body: string,
    private onYes: () => void,
    /** An extra choice beside Run (e.g. "Batch (half price)"). */
    private alt?: { label: string; onClick: () => void },
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.heading);
    this.contentEl.createEl("p", { text: this.body });
    const row = new Setting(this.contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    if (this.alt) {
      const alt = this.alt;
      row.addButton((b) =>
        b.setButtonText(alt.label).onClick(() => {
          this.close();
          alt.onClick();
        }),
      );
    }
    row.addButton((b) =>
        b
          .setButtonText("Run")
          .setCta()
          .onClick(() => {
            this.close();
            this.onYes();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
