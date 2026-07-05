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
  frequencyPenalty?: number;
  presencePenalty?: number;
  temperature?: number;
  topP?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** When set, the upstream `finish_reason` is written here (e.g. `length`). */
  finishState?: { reason?: string };
}

/** Clamp OpenAI-compatible penalty to documented range. */
export function clampOpenAiPenalty(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(2, Math.max(0, value));
}

export function buildVllmChatBody(opts: {
  model: string;
  messages: VllmChatMessage[];
  stream: boolean;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  temperature?: number;
  topP?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: opts.stream,
    max_tokens: opts.maxTokens ?? maxTokensFromEnv(),
  };
  if (opts.frequencyPenalty !== undefined) {
    body.frequency_penalty = clampOpenAiPenalty(opts.frequencyPenalty);
  }
  if (opts.presencePenalty !== undefined) {
    body.presence_penalty = clampOpenAiPenalty(opts.presencePenalty);
  }
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.topP !== undefined) body.top_p = opts.topP;
  return body;
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

type VllmStreamChoice = {
  delta?: { content?: string | null; reasoning_content?: string | null };
  message?: { content?: string | null };
  finish_reason?: string | null;
};

/** Extract assistant text from one vLLM/OpenAI streaming chunk. */
export function streamTextFromVllmChoice(choice: VllmStreamChoice | undefined): string | undefined {
  const deltaContent = choice?.delta?.content;
  if (typeof deltaContent === "string" && deltaContent.length > 0) return deltaContent;
  const reasoning = choice?.delta?.reasoning_content;
  if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
  const messageContent = choice?.message?.content;
  if (typeof messageContent === "string" && messageContent.length > 0) return messageContent;
  return undefined;
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
    body: JSON.stringify(
      buildVllmChatBody({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        maxTokens: opts.maxTokens,
        frequencyPenalty: opts.frequencyPenalty,
        presencePenalty: opts.presencePenalty,
        temperature: opts.temperature,
        topP: opts.topP,
      }),
    ),
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
        const chunk = JSON.parse(data) as { choices?: VllmStreamChoice[] };
        const choice = chunk.choices?.[0];
        const finish = choice?.finish_reason;
        if (finish && finish !== "null") {
          if (opts.finishState) opts.finishState.reason = finish;
        }
        const text = streamTextFromVllmChoice(choice);
        if (text) yield text;
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

/** Task vLLM upstream (localhost :8001 inside prod-engine guest). */
export function vllmTaskConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  baseUrl: string;
  apiKey?: string;
} | null {
  const baseUrl =
    env.VLLM_TASK_BASE_URL?.trim() ||
    env.TEECHAT_TASK_VLLM_BASE_URL?.trim() ||
    env.TEECHAT_VLLM_TASK_BASE_URL?.trim();
  if (!baseUrl) return null;
  const apiKey =
    env.VLLM_TASK_API_KEY?.trim() ||
    env.TEECHAT_TASK_VLLM_API_KEY?.trim() ||
    env.VLLM_API_KEY?.trim() ||
    env.TEECHAT_VLLM_API_KEY?.trim();
  return { baseUrl, apiKey: apiKey || undefined };
}

export function taskModelIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const id =
    env.TEECHAT_TASK_MODEL?.trim() ||
    env.VITE_TASK_MODEL?.trim() ||
    env.VLLM_TASK_MODEL?.trim() ||
    env.OLLAMA_TASK_MODEL?.trim();
  return id || null;
}

function stripModelProvider(model: string): string {
  const at = model.indexOf("@");
  return at >= 0 ? model.slice(0, at) : model;
}

export interface TaskVllmRouting {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
}

/** Route task-model ids to the task vLLM base URL; main chat models use the primary upstream. */
export function resolveVllmBaseUrlForModel(
  model: string,
  main: { baseUrl: string; apiKey?: string },
  task?: TaskVllmRouting | null,
): { baseUrl: string; model: string; apiKey?: string } {
  const stripped = stripModelProvider(model);
  if (task && stripModelProvider(task.modelId) === stripped) {
    return {
      baseUrl: task.baseUrl,
      model: stripped,
      apiKey: task.apiKey ?? main.apiKey,
    };
  }
  return { baseUrl: main.baseUrl, model: stripped, apiKey: main.apiKey };
}

export interface VllmCompleteOptions extends Omit<VllmStreamOptions, "finishState"> {
  temperature?: number;
}

/** Non-streaming OpenAI-compatible chat completion (gateway background jobs). */
export async function completeVllmChatCompletion(opts: VllmCompleteOptions): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = openAiChatCompletionsUrl(opts.baseUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey?.trim()) headers.Authorization = `Bearer ${opts.apiKey.trim()}`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    signal: opts.signal,
    body: JSON.stringify(
      buildVllmChatBody({
        model: opts.model,
        messages: opts.messages,
        stream: false,
        maxTokens: opts.maxTokens,
        frequencyPenalty: opts.frequencyPenalty,
        presencePenalty: opts.presencePenalty,
        temperature: opts.temperature,
        topP: opts.topP,
      }),
    ),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`vLLM HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const msg = choices[0] as Record<string, unknown>;
  const message = msg.message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content.trim();
  return "";
}
