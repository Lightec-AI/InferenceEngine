import { describe, expect, it } from "vitest";

import {
  streamTextFromVllmChoice,
  streamVllmChatCompletion,
} from "../src/upstream/vllm-chat.js";

describe("streamVllmChatCompletion", () => {
  it("yields delta.content chunks", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"He"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
      "data: [DONE]\n\n";
    const fetchImpl = async () =>
      ({
        ok: true,
        body: {
          getReader: () => {
            const enc = new TextEncoder();
            const bytes = enc.encode(sse);
            let sent = false;
            return {
              read: async () => {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: bytes };
              },
            };
          },
        },
      }) as Response;

    const parts: string[] = [];
    for await (const delta of streamVllmChatCompletion({
      baseUrl: "http://127.0.0.1:8000",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
    })) {
      parts.push(delta);
    }
    expect(parts).toEqual(["He", "llo"]);
  });

  it("falls back to reasoning_content and message.content", async () => {
    expect(
      streamTextFromVllmChoice({
        delta: { reasoning_content: "think" },
      }),
    ).toBe("think");
    expect(
      streamTextFromVllmChoice({
        message: { content: "final" },
      }),
    ).toBe("final");
    expect(
      streamTextFromVllmChoice({
        delta: { content: "delta" },
        message: { content: "final" },
      }),
    ).toBe("delta");
  });
});
