import { describe, expect, it } from "vitest";

import type { OpeEnvelope } from "../src/protocol/types.js";
import { CONTENT_TYPE_OPE_JSON } from "../src/protocol/types.js";
import {
  validateOpeInferenceContentType,
  validateOpeInferenceEnvelope,
} from "../src/server/ope-inference-gate.js";
import { runMockInferenceOnEnvelope } from "../src/engine-plane/inference-handler.js";

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

describe("ope-inference-gate", () => {
  it("accepts a hybrid E2E envelope", () => {
    expect(validateOpeInferenceEnvelope(validEnvelope()).ok).toBe(true);
  });

  it("rejects enc=none and inline payload", () => {
    expect(validateOpeInferenceEnvelope(validEnvelope({ enc: "none" })).error).toBe(
      "plaintext_payload_forbidden",
    );
    expect(
      validateOpeInferenceEnvelope(
        validEnvelope({ payload: { messages: [] } } as unknown as OpeEnvelope),
      ).error,
    ).toBe("plaintext_payload_forbidden");
  });

  it("rejects missing engine_id or wrong enc", () => {
    expect(validateOpeInferenceEnvelope(validEnvelope({ engine_id: "" })).error).toBe(
      "e2e_envelope_required",
    );
    expect(validateOpeInferenceEnvelope(validEnvelope({ enc: "xchacha20poly1305" })).error).toBe(
      "e2e_envelope_required",
    );
  });

  it("rejects missing ciphertext or e2e epoch keys", () => {
    expect(validateOpeInferenceEnvelope(validEnvelope({ ciphertext: "" })).error).toBe(
      "ciphertext_required",
    );
    expect(
      validateOpeInferenceEnvelope(
        validEnvelope({
          e2e: { kex: "X25519MLKEM768", ephemeral_epoch: "e1" },
        }),
      ).error,
    ).toBe("e2e_ephemeral_epoch_required");
  });

  it("requires application/ope+json content type on HTTP", () => {
    expect(validateOpeInferenceContentType("application/json").ok).toBe(false);
    expect(validateOpeInferenceContentType(CONTENT_TYPE_OPE_JSON).ok).toBe(true);
  });

  it("runMockInferenceOnEnvelope rejects plain envelopes before decrypt", async () => {
    const res = await runMockInferenceOnEnvelope(validEnvelope({ enc: "none" }), {
      decryptor: {
        handle: 1,
        provider: {
          decryptRequest: () => ({ messages: [{ role: "user", content: "hi" }] }),
        } as never,
      },
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("plaintext_payload_forbidden");
  });
});
