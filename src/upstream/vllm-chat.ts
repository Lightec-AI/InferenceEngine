export interface VllmChatMessage {
  role: string;
  content: string;
}

export interface VllmStreamOptions {
  baseUrl: string;
  model: string;
  messages: VllmChatMessage[];
  apiKey?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

/** Stream completion text deltas from an OpenAI-compatible vLLM `/v1/chat/completions`. */
export async function* streamVllmChatCompletion(
  opts: VllmStreamOptions,
): AsyncGenerator<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${normalizeBaseUrl(opts.baseUrl)}/v1/chat/completions`;
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
      max_tokens: opts.maxTokens ?? 1024,
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
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = chunk.choices?.[0]?.delta?.content;
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
