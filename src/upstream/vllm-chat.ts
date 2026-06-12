import type { VllmChatMessage } from "./vllm-multimodal.js";

export type { VllmChatMessage, VllmContentPart } from "./vllm-multimodal.js";
export { estimatePromptTokensFromMessages, normalizeVllmMessages } from "./vllm-multimodal.js";

export const VLLM_MAX_TOKENS_DEFAULT = 4096;
export const VLLM_MAX_TOKENS_MIN = 256;
export const VLLM_MAX_TOKENS_MAX = 32_768;

export const VLLM_OUTPUT_TOKEN_LIMIT_NOTICE =
  "\n\n*Generation stopped: the model hit its output token limit. Send a follow-up to continue.*";

export function clampVllmMaxTokens(n: number): number {
  return Math.min(VLLM_MAX_TOKENS_MAX, Math.max(VLLM_MAX_TOKENS_MIN, Math.floor(n)));
}

export function maxTokensFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw =
    env.TEECHAT_OPE_MAX_TOKENS?.trim() || env.TEECHAT_VLLM_MAX_TOKENS?.trim() || "";
  if (!raw) return VLLM_MAX_TOKENS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return VLLM_MAX_TOKENS_DEFAULT;
  return clampVllmMaxTokens(n);
}

export interface VllmStreamOptions {
  baseUrl: string;
  model: string;
  messages: VllmChatMessage[];
  apiKey?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** When set, the upstream `finish_reason` is written here (e.g. `length`). */
  finishState?: { reason?: string };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** OpenAI-compatible chat completions URL (base may be `http://host` or `http://host/v1`). */
export function openAiChatCompletionsUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** Stream completion text deltas from an OpenAI-compatible vLLM `/v1/chat/completions`. */
export async function* streamVllmChatCompletion(
  opts: VllmStreamOptions,
): AsyncGenerator<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = openAiChatCompletionsUrl(opts.baseUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey?.trim()) headers.Authorization = `Bearer ${opts.apiKey.trim()}`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: true,
      max_tokens: opts.maxTokens ?? maxTokensFromEnv(),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`vLLM HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.body) throw new Error("vLLM response missing body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const chunk = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
        };
        const choice = chunk.choices?.[0];
        const finish = choice?.finish_reason;
        if (finish && finish !== "null") {
          if (opts.finishState) opts.finishState.reason = finish;
        }
        const delta = choice?.delta?.content;
        if (delta) yield delta;
      } catch {
        /* ignore malformed SSE lines */
      }
    }
  }
}

export function vllmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  baseUrl: string;
  apiKey?: string;
} | null {
  const baseUrl = env.VLLM_BASE_URL?.trim() || env.TEECHAT_VLLM_BASE_URL?.trim();
  if (!baseUrl) return null;
  const apiKey = env.VLLM_API_KEY?.trim() || env.TEECHAT_VLLM_API_KEY?.trim();
  return { baseUrl, apiKey: apiKey || undefined };
}
