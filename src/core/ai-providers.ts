/**
 * AI providers for the optional helpers. Anthropic is called through its SDK; every other provider
 * is called through the OpenAI-compatible "chat completions" shape, which OpenAI, Google Gemini,
 * OpenRouter and local servers (Ollama, LM Studio) all accept.
 */
export type AiProvider = "anthropic" | "openai" | "gemini" | "openrouter" | "custom";

/** `model`: a small model of that provider known to work, filled in when the model box is empty. */
export const AI_PROVIDERS: Record<AiProvider, { label: string; baseUrl: string; keyHint: string; model?: string }> = {
  anthropic: { label: "Anthropic (Claude)", baseUrl: "", keyHint: "sk-ant-…" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyHint: "sk-…" },
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyHint: "AIza…", model: "gemini-flash-latest" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyHint: "sk-or-…" },
  custom: { label: "Other (OpenAI-compatible, or a local model)", baseUrl: "", keyHint: "API key (leave empty for a local model)" },
};

export function isProvider(v: unknown): v is AiProvider {
  return typeof v === "string" && v in AI_PROVIDERS;
}

/** Where a provider's key is kept in the device's secret store. Anthropic keeps its original id. */
export function aiKeyId(provider: AiProvider): string {
  return provider === "anthropic" ? "flashcards-anthropic-key" : `flashcards-ai-key-${provider}`;
}

/** The chat-completions URL for a provider ("custom" uses the address the user typed). */
export function chatUrl(provider: AiProvider, customBase: string): string {
  const base = (provider === "custom" ? customBase : AI_PROVIDERS[provider].baseUrl).trim().replace(/\/+$/, "");
  if (!base) return "";
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

/** The request body: the reply must be one JSON object that fits `schema`. */
export function chatBody(model: string, system: string, user: string, schema: unknown): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: `${system}\n\nReply with one JSON object only, no other text, matching this JSON Schema:\n${JSON.stringify(schema)}` },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
  };
}

/** The JSON object inside a chat-completions reply (models sometimes wrap it in a code fence or prose). */
export function chatJson(reply: unknown): unknown {
  const choice = (reply as { choices?: Array<{ message?: { content?: unknown; refusal?: unknown }; finish_reason?: string }> })?.choices?.[0];
  if (!choice) throw new Error("The reply couldn't be read.");
  if (choice.message?.refusal) throw new Error("The model declined this request.");
  if (choice.finish_reason === "length") throw new Error("The reply was cut off (too long).");
  const content = choice.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p as { text?: string }).text ?? "").join("") : "";
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("The reply couldn't be read.");
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    throw new Error("The reply couldn't be read.");
  }
}
