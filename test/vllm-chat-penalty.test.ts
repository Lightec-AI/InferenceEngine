import { describe, expect, it } from "vitest";

import { buildVllmChatBody, clampOpenAiPenalty } from "../src/upstream/vllm-chat.js";

describe("clampOpenAiPenalty", () => {
  it("clamps to OpenAI range 0..2", () => {
    expect(clampOpenAiPenalty(-1)).toBe(0);
    expect(clampOpenAiPenalty(0.4)).toBe(0.4);
    expect(clampOpenAiPenalty(3)).toBe(2);
    expect(clampOpenAiPenalty(Number.NaN)).toBe(0);
  });
});

describe("buildVllmChatBody", () => {
  it("includes penalties when provided", () => {
    const body = buildVllmChatBody({
      model: "gemma",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      frequencyPenalty: 0.55,
      presencePenalty: 0.15,
    });
    expect(body.frequency_penalty).toBe(0.55);
    expect(body.presence_penalty).toBe(0.15);
  });

  it("omits penalties when undefined", () => {
    const body = buildVllmChatBody({
      model: "gemma",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(body).not.toHaveProperty("frequency_penalty");
    expect(body).not.toHaveProperty("presence_penalty");
  });
});
