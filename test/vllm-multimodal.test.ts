import { describe, expect, it } from "vitest";

import {
  estimatePromptTokensFromMessages,
  normalizeVllmMessages,
} from "../src/upstream/vllm-multimodal.js";

describe("normalizeVllmMessages", () => {
  it("passes multimodal content arrays through", () => {
    const out = normalizeVllmMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
    ]);
    expect(out[0]?.content).toEqual([
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ]);
  });
});

describe("estimatePromptTokensFromMessages", () => {
  it("counts images", () => {
    expect(
      estimatePromptTokensFromMessages([
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }],
        },
      ]),
    ).toBeGreaterThan(500);
  });
});
