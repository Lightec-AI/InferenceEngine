import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { OpeEnvelope } from "../src/protocol/types.js";
import { INFERENCE_PATH } from "../src/protocol/types.js";
import { createMockInferenceServer } from "../src/server/mock-inference.js";

describe("mock inference engine prefill", () => {
  let server: http.Server | undefined;
  let baseUrl = "";

  afterEach(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
  });

  it("reports smaller engine_prefill_tokens on second turn with same prefix hash", async () => {
    const mock = await createMockInferenceServer();
    server = mock.server;
    baseUrl = mock.baseUrl;

    const base: OpeEnvelope = {
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
      iv: "iv",
    };

    const first = await fetch(`${baseUrl}${INFERENCE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(base),
    });
    const firstBody = (await first.json()) as { engine_prefill_tokens: number };

    const second = await fetch(`${baseUrl}${INFERENCE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...base,
        nonce: "n2",
        ciphertext: `${"a".repeat(80)}new-turn`,
      }),
    });
    const secondBody = (await second.json()) as { engine_prefill_tokens: number };

    expect(firstBody.engine_prefill_tokens).toBeGreaterThan(0);
    expect(secondBody.engine_prefill_tokens).toBeGreaterThan(0);
    expect(secondBody.engine_prefill_tokens).toBeLessThan(firstBody.engine_prefill_tokens);
  });
});
