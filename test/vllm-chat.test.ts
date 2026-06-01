import { describe, expect, it } from "vitest";

import { streamVllmChatCompletion } from "../src/upstream/vllm-chat.js";

describe("vllm-chat upstream", () => {
  it("parses SSE deltas from OpenAI-compatible stream", async () => {
    const sse = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n",
      "\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n",
      "\n",
      "data: [DONE]\n",
    ].join("");

    const fetchImpl = async () =>
      ({
        ok: true,
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: async () => {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: new TextEncoder().encode(sse) };
              },
            };
          },
        },
      }) as Response;

    const parts: string[] = [];
    for await (const delta of streamVllmChatCompletion({
      baseUrl: "http://127.0.0.1:8000",
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
    })) {
      parts.push(delta);
    }
    expect(parts.join("")).toBe("Hello");
  });
});
