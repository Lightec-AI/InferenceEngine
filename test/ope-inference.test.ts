import { describe, expect, it } from "vitest";

import { createMockProvider } from "../src/crypto/provider.js";
import { runOpeInferenceOnEnvelope } from "../src/server/ope-inference.js";
import type { OpeEnvelope } from "../src/protocol/types.js";

describe("ope-inference (E-1)", () => {
  it("returns vllm_not_configured without upstream URL", async () => {
    const provider = createMockProvider();
    const res = await runOpeInferenceOnEnvelope({} as OpeEnvelope, {
      decryptor: { handle: 0, provider },
    });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toBe("vllm_not_configured");
  });

  it("streams vLLM output into encrypted chunks when decryptor is mock-only", async () => {
    const provider = createMockProvider();
    const envelope = {
      meta: { conversation_id: "c1", model: "llama3@teechat" },
      engine_id: "e1",
    } as OpeEnvelope;

    const sse = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n",
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

    const res = await runOpeInferenceOnEnvelope(envelope, {
      decryptor: { handle: 0, provider },
      vllm: { baseUrl: "http://127.0.0.1:8000", fetchImpl },
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("decrypt_failed");
  });
});
