export type VllmContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface VllmChatMessage {
  role: string;
  content: string | VllmContentPart[];
}

/** Normalize decrypted OPE messages for OpenAI-compatible vLLM upstream. */
export function normalizeVllmMessages(
  messages: Array<{ role?: string; content?: unknown }>,
): VllmChatMessage[] {
  return messages.map((m) => {
    const role = m.role ?? "user";
    const content = m.content;
    if (typeof content === "string") return { role, content };
    if (Array.isArray(content)) {
      const parts: VllmContentPart[] = [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") {
          parts.push({ type: "text", text: p.text });
        } else if (p.type === "image_url" && p.image_url && typeof p.image_url === "object") {
          const url = (p.image_url as { url?: unknown }).url;
          if (typeof url === "string") {
            parts.push({ type: "image_url", image_url: { url } });
          }
        }
      }
      if (parts.length > 0) return { role, content: parts };
    }
    return { role, content: JSON.stringify(content ?? "") };
  });
}

export function estimatePromptTokensFromMessages(messages: VllmChatMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
      continue;
    }
    for (const part of m.content) {
      if (part.type === "text") chars += part.text.length;
      if (part.type === "image_url") images += 1;
    }
  }
  return Math.max(1, Math.ceil(chars / 4) + images * 512);
}
