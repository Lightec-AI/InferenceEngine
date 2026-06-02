import { describe, expect, it } from "vitest";

import { openAiChatCompletionsUrl } from "../src/upstream/vllm-chat.js";

describe("openAiChatCompletionsUrl", () => {
  it("does not double /v1 when base already includes it (Ollama)", () => {
    expect(openAiChatCompletionsUrl("http://127.0.0.1:11434/v1")).toBe(
      "http://127.0.0.1:11434/v1/chat/completions",
    );
  });

  it("appends /v1 for bare host bases (typical vLLM)", () => {
    expect(openAiChatCompletionsUrl("http://gpu.local:8000")).toBe(
      "http://gpu.local:8000/v1/chat/completions",
    );
  });
});
