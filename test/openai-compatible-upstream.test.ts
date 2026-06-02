import { describe, expect, it } from "vitest";

import {
  DEFAULT_OLLAMA_OPENAI_BASE_URL,
  pickUpstreamModel,
  probeOllamaUpstream,
  resolveOpenAiCompatibleUpstream,
} from "../src/upstream/openai-compatible-upstream.js";

describe("openai-compatible upstream", () => {
  it("probes Ollama tags API", async () => {
    const fetchImpl = async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "llama3.2:3b" }, { name: "qwen2.5:7b" }] }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    };

    const probe = await probeOllamaUpstream({
      baseUrl: DEFAULT_OLLAMA_OPENAI_BASE_URL,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(probe?.kind).toBe("ollama");
    expect(probe?.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(probe?.models[0]).toBe("llama3.2:3b");
  });

  it("skips guard-tagged models when auto-picking", () => {
    const model = pickUpstreamModel({
      baseUrl: DEFAULT_OLLAMA_OPENAI_BASE_URL,
      models: ["sileader/qwen3guard:0.6b", "llama3.1:8b"],
      kind: "ollama",
    });
    expect(model).toBe("llama3.1:8b");
  });

  it("prefers VLLM_BASE_URL env over Ollama probe", async () => {
    const probe = await resolveOpenAiCompatibleUpstream({
      env: { VLLM_BASE_URL: "http://gpu.local:8000/v1", OLLAMA_MODEL: "gemma" },
      probeOllama: false,
    });
    expect(probe?.baseUrl).toBe("http://gpu.local:8000/v1");
    expect(probe?.models).toEqual(["gemma"]);
  });
});
