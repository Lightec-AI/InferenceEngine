import http from "node:http";
import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { createMockProvider, createRealProvider } from "../src/crypto/provider.js";
import { createEngineEpoch, disposeEngineEpoch } from "../src/engine/epoch.js";
import { verifyEphemeralIdentitySignature } from "../src/ephemeral.js";
import { createMockInferenceServer } from "../src/server/mock-inference.js";
import { HEADER_USAGE_REPORT, INFERENCE_PATH, type SignedUsageReport } from "../src/protocol/types.js";

function ed25519Pair(): { pub: string; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = (publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .subarray(-32)
    .toString("base64url");
  return { pub, priv: privateKey };
}

describe("engine epoch creation", () => {
  it("mock provider yields a signed epoch with no native handle", () => {
    const { pub, priv } = ed25519Pair();
    const epoch = createEngineEpoch({
      engineId: "engine-mock",
      ed25519PublicB64: pub,
      ed25519PrivateKey: priv,
      provider: createMockProvider(),
    });
    expect(epoch.handle).toBeNull();
    expect(verifyEphemeralIdentitySignature(pub, epoch.ephemeralRequest)).toBe(true);
  });

  it("real provider yields a live handle and a verifiable signed epoch", () => {
    const { pub, priv } = ed25519Pair();
    const epoch = createEngineEpoch({
      engineId: "engine-real",
      ed25519PublicB64: pub,
      ed25519PrivateKey: priv,
      provider: createRealProvider(),
    });
    expect(epoch.handle).not.toBeNull();
    expect(epoch.hybrid.mlkem_encapsulation_key.length).toBeGreaterThan(1000);
    expect(verifyEphemeralIdentitySignature(pub, epoch.ephemeralRequest)).toBe(true);
    disposeEngineEpoch(epoch);
  });
});

describe("mock inference server with real decryption", () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  it("decrypts the real request and meters from the actual prompt", async () => {
    const provider = createRealProvider();
    const { pub, priv } = ed25519Pair();
    const epoch = createEngineEpoch({
      engineId: "engine-decrypt",
      ed25519PublicB64: pub,
      ed25519PrivateKey: priv,
      provider,
    });

    let seenPrefill = -1;
    const built = await createMockInferenceServer(
      (_env, prefillTokens) => {
        seenPrefill = prefillTokens;
        const report = {
          request_id: "req-1",
          conversation_id: "conv-real",
          engine_id: "engine-decrypt",
          prompt_tokens: prefillTokens,
          completion_tokens: 7,
          ts: new Date().toISOString(),
        };
        return { report, sig: "sig" } as SignedUsageReport;
      },
      { decryptor: { handle: epoch.handle!, provider } },
    );
    server = built.server;

    const identity = {
      engine_id: "engine-decrypt",
      kex: epoch.hybrid.kex,
      mlkem_encapsulation_key: epoch.hybrid.mlkem_encapsulation_key,
      x25519_public: epoch.hybrid.x25519_public,
      ed25519_public: pub,
    };
    const longPrompt = "x".repeat(400);
    const { envelope } = provider.clientEncryptRequest(
      identity,
      { model: "llama3@teechat", messages: [{ role: "user", content: longPrompt }] },
      {
        ope_version: "1.0",
        alg: "EdDSA",
        enc: "none",
        kid: "user-1",
        recipient: "teechat-gateway",
        ts: new Date().toISOString(),
        nonce: "nonce-real-1",
        payload_hash: "",
      },
      false,
    );
    (envelope as Record<string, unknown>).meta = { conversation_id: "conv-real", model: "llama3@teechat" };

    const res = await fetch(`${built.baseUrl}${INFERENCE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADER_USAGE_REPORT)).toBeTruthy();
    // Cold prefill should reflect the decrypted ~400-char prompt, not the ciphertext length.
    expect(seenPrefill).toBeGreaterThanOrEqual(100);

    disposeEngineEpoch(epoch);
  });

  it("rejects an envelope it cannot decrypt", async () => {
    const provider = createRealProvider();
    const { pub, priv } = ed25519Pair();
    const epoch = createEngineEpoch({
      engineId: "engine-bad",
      ed25519PublicB64: pub,
      ed25519PrivateKey: priv,
      provider,
    });
    const built = await createMockInferenceServer(undefined, {
      decryptor: { handle: epoch.handle!, provider },
    });
    server = built.server;

    const res = await fetch(`${built.baseUrl}${INFERENCE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ope_version: "1.0",
        alg: "EdDSA",
        enc: "e2e-hybrid-pq",
        kid: "k",
        recipient: "r",
        ts: new Date().toISOString(),
        nonce: "n",
        payload_hash: "",
        ciphertext: "not-real",
        iv: "AAAAAAAAAAAAAAAA",
        e2e: { kex: "X25519MLKEM768", client_x25519: "AA", mlkem_ciphertext: "AA" },
      }),
    });
    expect(res.status).toBe(400);
    disposeEngineEpoch(epoch);
  });
});
