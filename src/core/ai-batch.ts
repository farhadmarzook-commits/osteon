/**
 * Batch mode for the AI term pass (spec 0005 §3, "big first runs"): many cards go to Anthropic's
 * Message Batches API in one submission (half price, results within 24 hours) instead of one request
 * at a time. These are the pure parts: splitting cards into requests and turning results into
 * glossary lines. Tested.
 */
import { formatAiCard, formatAiTerm } from "./terms";

export interface BatchPlan {
  /** custom_id → the user message for that request. */
  requests: Array<{ customId: string; user: string }>;
  /** custom_id → card hashes in that request (to mark them looked at once the result is in). */
  cards: Record<string, string[]>;
}

/** Group cards (hash + text) into requests of `perRequest`, in the same card markup as live runs. */
export function planBatch(cards: Array<{ hash: string; text: string }>, perRequest: number): BatchPlan {
  const plan: BatchPlan = { requests: [], cards: {} };
  for (let i = 0; i < cards.length; i += perRequest) {
    const group = cards.slice(i, i + perRequest);
    const customId = `r${i / perRequest}`;
    plan.requests.push({ customId, user: `Cards:\n${group.map((c) => `<card id="${c.hash}">\n${c.text}\n</card>`).join("\n")}` });
    plan.cards[customId] = group.map((c) => c.hash);
  }
  return plan;
}

export interface BatchResult {
  customId: string;
  /** The reply's JSON text for a succeeded request; undefined for errored/expired/cancelled ones. */
  json?: string;
}

/**
 * Glossary lines from finished requests. Cards in requests that failed or couldn't be read are not
 * marked, so a later run picks them up again.
 */
export function linesFromBatch(
  results: BatchResult[],
  cardsByRequest: Record<string, string[]>,
  model: string,
  date: string,
): { lines: string[]; terms: number; cardsDone: number; failedRequests: number } {
  const lines: string[] = [];
  let terms = 0;
  let cardsDone = 0;
  let failedRequests = 0;
  for (const r of results) {
    const hashes = cardsByRequest[r.customId];
    if (!hashes) continue;
    type Reply = { cards?: Array<{ terms?: Array<{ term?: string; definition?: string }> }> } | null;
    let parsed: Reply = null;
    try {
      parsed = r.json ? (JSON.parse(r.json) as Reply) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || !Array.isArray(parsed.cards)) {
      failedRequests++;
      continue;
    }
    for (const c of parsed.cards) {
      for (const t of c.terms ?? []) {
        if (!t.term?.trim() || !t.definition?.trim()) continue;
        lines.push(formatAiTerm(t.term, t.definition, model, date));
        terms++;
      }
    }
    for (const h of hashes) lines.push(formatAiCard(h));
    cardsDone += hashes.length;
  }
  return { lines, terms, cardsDone, failedRequests };
}
