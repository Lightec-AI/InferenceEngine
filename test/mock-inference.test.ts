import { beforeEach, describe, expect, it } from "vitest";

import { resetMockInferenceKvState, runMockInferenceOnEnvelope } from "../src/engine-plane/inference-handler.js";
import type { OpeEnvelope } from "../src/protocol/types.js";

function validEnvelope(overrides: Partial<OpeEnvelope> = {}): OpeEnvelope {
  return {
    ope_version: "1.0",
    alg: "EdDSA",
    enc: "e2e-hybrid-pq",
    kid: "user-1",
    recipient: "teechat-gateway",
    ts: new Date().toISOString(),
    nonce: "n1",
    payload_hash: "hash",
    engine_id: "engine-test",
    meta: { conversation_id: "conv-a", model: "llama3" },
    sig: "sig",
    ciphertext: "a".repeat(80),
    iv: "AAAAAAAAAAAAAAAA",
    e2e: {
      kex: "X25519MLKEM768",
      engine_mlkem_encap: "encap",
      engine_x25519: "x25519",
      ephemeral_epoch: "epoch-1",
    },
    ...overrides,
  };
}

const mockDecryptor = {
  handle: 1,
  provider: {
    decryptRequest: (_handle: number, envelope: OpeEnvelope) => {
      const len = (envelope.ciphertext ?? "").length;
      return {
        messages: [{ role: "user", content: "x".repeat(Math.max(1, Math.floor(len / 4))) }],
      };
    },
  },
};

describe("mock inference engine prefill", () => {
  beforeEach(() => {
    delete process.env.VLLM_BASE_URL;
    delete process.env.TEECHAT_VLLM_BASE_URL;
    resetMockInferenceKvState();
  });

  it("reports smaller engine_prefill_tokens on second turn with same prefix hash", async () => {

    const base = validEnvelope();

    const first = await runMockInferenceOnEnvelope(base, { decryptor: mockDecryptor });
    const firstBody = JSON.parse(first.body) as { engine_prefill_tokens: number };

    const second = await runMockInferenceOnEnvelope(
      validEnvelope({
        nonce: "n2",
        ciphertext: `${"a".repeat(80)}new-turn`,
      }),
      { decryptor: mockDecryptor },
    );
    const secondBody = JSON.parse(second.body) as { engine_prefill_tokens: number };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstBody.engine_prefill_tokens).toBeGreaterThan(0);
    expect(secondBody.engine_prefill_tokens).toBeGreaterThan(0);
    expect(secondBody.engine_prefill_tokens).toBeLessThan(firstBody.engine_prefill_tokens);
  });
});
