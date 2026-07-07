import { describe, expect, it } from "vitest";

import { resolveVllmBaseUrlForModel } from "../src/upstream/vllm-chat.js";

describe("resolveVllmBaseUrlForModel", () => {
  it("uses task base URL for the configured task model id", () => {
    const routed = resolveVllmBaseUrlForModel(
      "google/gemma-4-E4B-it@teechat",
      { baseUrl: "http://127.0.0.1:8000/v1" },
      { baseUrl: "http://127.0.0.1:8001/v1", modelId: "google/gemma-4-E4B-it" },
    );
    expect(routed.baseUrl).toBe("http://127.0.0.1:8001/v1");
    expect(routed.model).toBe("google/gemma-4-E4B-it");
    expect(routed.isTaskModel).toBe(true);
  });

  it("keeps main chat models on the primary upstream", () => {
    const routed = resolveVllmBaseUrlForModel(
      "google/gemma-4-31B-it@teechat",
      { baseUrl: "http://127.0.0.1:8000/v1" },
      { baseUrl: "http://127.0.0.1:8001/v1", modelId: "google/gemma-4-E4B-it" },
    );
    expect(routed.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(routed.model).toBe("google/gemma-4-31B-it");
    expect(routed.isTaskModel).toBe(false);
  });
});
