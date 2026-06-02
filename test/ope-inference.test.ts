import { describe, expect, it } from "vitest";

import { createMockProvider } from "../src/crypto/provider.js";
import { runOpeInferenceOnEnvelope } from "../src/server/ope-inference.js";
import type { OpeEnvelope } from "../src/protocol/types.js";

function validEnvelope(overrides: Partial<OpeEnvelope> = {}): OpeEnvelope {
  return {
    ope_version: "1.0",
    alg: "EdDSA",
    enc: "e2e-hybrid-pq",
    kid: "k",
    recipient: "r",
    ts: new Date().toISOString(),
    nonce: "n",
    payload_hash: "",
    engine_id: "e1",
    ciphertext: "ct",
    iv: "AAAAAAAAAAAAAAAA",
    e2e: {
      kex: "X25519MLKEM768",
      engine_mlkem_encap: "encap",
      engine_x25519: "x25519",
      ephemeral_epoch: "epoch-1",
    },
    meta: { conversation_id: "c1", model: "llama3@teechat" },
    ...overrides,
  };
}

describe("ope-inference (E-1)", () => {
  it("rejects non-OPE envelopes before upstream", async () => {
    const provider = createMockProvider();
    const res = await runOpeInferenceOnEnvelope({} as OpeEnvelope, {
      decryptor: { handle: 0, provider },
      vllm: { baseUrl: "http://127.0.0.1:8000" },
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("e2e_envelope_required");
  });

  it("returns vllm_not_configured without upstream URL", async () => {
    const provider = createMockProvider();
    const res = await runOpeInferenceOnEnvelope(validEnvelope(), {
      decryptor: { handle: 0, provider },
    });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toBe("vllm_not_configured");
  });

  it("streams vLLM output into encrypted chunks when decryptor is mock-only", async () => {
    const provider = createMockProvider();
    const envelope = validEnvelope();

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
