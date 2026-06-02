import { vllmConfigFromEnv } from "./vllm-chat.js";

export const DEFAULT_OLLAMA_OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";

export interface OpenAiCompatibleUpstreamProbe {
  baseUrl: string;
  models: string[];
  kind: "ollama" | "vllm" | "openai_compatible";
}

function normalizeOpenAiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function ollamaOriginFromOpenAiBase(baseUrl: string): string {
  return normalizeOpenAiBaseUrl(baseUrl).replace(/\/v1$/, "");
}

/** List models from Ollama `GET /api/tags`. */
export async function probeOllamaUpstream(opts: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<OpenAiCompatibleUpstreamProbe | null> {
  const baseUrl = normalizeOpenAiBaseUrl(opts.baseUrl ?? DEFAULT_OLLAMA_OPENAI_BASE_URL);
  const origin = ollamaOriginFromOpenAiBase(baseUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 3_000;

  try {
    const res = await fetchImpl(`${origin}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models ?? [])
      .map((m) => m.name?.trim())
      .filter((n): n is string => Boolean(n));
    if (!models.length) return null;
    return { baseUrl, models, kind: "ollama" };
  } catch {
    return null;
  }
}

/**
 * Resolve OpenAI-compatible upstream for engine inference (vLLM, Ollama, etc.).
 * Order: `VLLM_BASE_URL` / `TEECHAT_VLLM_BASE_URL` → probe local Ollama → null.
 */
export async function resolveOpenAiCompatibleUpstream(opts: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  probeOllama?: boolean;
} = {}): Promise<OpenAiCompatibleUpstreamProbe | null> {
  const env = opts.env ?? process.env;
  const fromEnv = vllmConfigFromEnv(env);
  if (fromEnv?.baseUrl) {
    const baseUrl = normalizeOpenAiBaseUrl(fromEnv.baseUrl);
    const modelEnv = env.OLLAMA_MODEL?.trim() || env.TEECHAT_OLLAMA_MODEL?.trim();
    if (modelEnv) {
      return { baseUrl, models: [modelEnv], kind: "openai_compatible" };
    }
    if (opts.probeOllama !== false && /11434/.test(baseUrl)) {
      const ollama = await probeOllamaUpstream({ baseUrl, fetchImpl: opts.fetchImpl });
      if (ollama) return ollama;
    }
    return { baseUrl, models: [], kind: "openai_compatible" };
  }

  if (opts.probeOllama === false) return null;
  return probeOllamaUpstream({ fetchImpl: opts.fetchImpl });
}

/** Prefer a general chat model over guard-only tags when auto-selecting from Ollama. */
export function pickUpstreamModel(
  probe: OpenAiCompatibleUpstreamProbe,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.OLLAMA_MODEL?.trim() || env.TEECHAT_OLLAMA_MODEL?.trim();
  if (explicit) return explicit;
  const chatish = probe.models.find(
    (m) => !/\bguard\b/i.test(m) && !/qwen3guard/i.test(m),
  );
  if (chatish) return chatish;
  if (probe.models.length) return probe.models[0]!;
  throw new Error("no upstream model: set OLLAMA_MODEL or start Ollama with at least one model");
}
