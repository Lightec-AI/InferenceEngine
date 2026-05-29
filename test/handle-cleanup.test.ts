import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { OpeClient } from "../src/client/ope-client.js";
import type { CryptoProvider, EngineHybridKeypair } from "../src/crypto/provider.js";
import { createEngineEpoch } from "../src/engine/epoch.js";
import { DEFAULT_TEST_ATTESTATION_POLICY } from "../src/attestation.js";
import type { VerifiedEngine } from "../src/client/ope-client.js";

/** Minimal provider that hands out fixed handles and records frees (SEC-028). */
function fakeProvider(overrides: Partial<CryptoProvider> = {}): CryptoProvider {
  const base: CryptoProvider = {
    mode: "mock",
    generateEngineHybrid(): EngineHybridKeypair {
      return {
        handle: 4242,
        hybrid: {
          kex: "X25519MLKEM768",
          mlkem_encapsulation_key: "AAAA",
          x25519_public: "BBBB",
        },
      };
    },
    decryptRequest: () => ({}),
    beginResponse: () => ({ session: 1, serverShare: "s" }),
    encryptResponseChunk: () => "c",
    freeResponse: () => {},
    freeEngine: () => {},
    clientEncryptRequest: () => ({ envelope: { e2e: {} }, client_session: 77 }),
    clientDecryptResponseChunk: () => Buffer.from(""),
    freeClientSession: () => {},
  };
  return { ...base, ...overrides };
}

describe("native handle cleanup on error (SEC-028)", () => {
  it("createEngineEpoch frees the engine handle when signing fails", () => {
    const freeEngine = vi.fn();
    const provider = fakeProvider({ freeEngine });
    // Passing a *public* key where a private key is expected makes `sign()` throw
    // after the native handle was already allocated by generateEngineHybrid.
    const { publicKey } = generateKeyPairSync("ed25519");

    expect(() =>
      createEngineEpoch({
        engineId: "engine-x",
        ed25519PublicB64: "AAAA",
        ed25519PrivateKey: publicKey,
        provider,
      }),
    ).toThrow();
    expect(freeEngine).toHaveBeenCalledWith(4242);
  });

  it("createEngineEpoch does not free on the happy path", () => {
    const freeEngine = vi.fn();
    const provider = fakeProvider({ freeEngine });
    const { privateKey } = generateKeyPairSync("ed25519");
    const epoch = createEngineEpoch({
      engineId: "engine-ok",
      ed25519PublicB64: "AAAA",
      ed25519PrivateKey: privateKey,
      provider,
    });
    expect(epoch.handle).toBe(4242);
    expect(freeEngine).not.toHaveBeenCalled();
  });

  it("OpeClient.encryptRequest frees the client session when signEnvelope throws", () => {
    const freeClientSession = vi.fn();
    const provider = fakeProvider({ freeClientSession });
    const client = new OpeClient({
      gatewayBaseUrl: "http://gw.invalid",
      tlsClientCertSha256: "deadbeef",
      attestationPolicy: DEFAULT_TEST_ATTESTATION_POLICY,
      provider,
      signEnvelope: () => {
        throw new Error("signing blew up");
      },
    });
    const engine: VerifiedEngine = {
      engineId: "engine-x",
      epochId: "epoch-1",
      identity: {
        engine_id: "engine-x",
        kex: "X25519MLKEM768",
        mlkem_encapsulation_key: "AAAA",
        x25519_public: "BBBB",
        ed25519_public: "CCCC",
      },
      trust: {} as VerifiedEngine["trust"],
    };

    expect(() => client.encryptRequest(engine, { hi: 1 }, { kid: "u" })).toThrow(/signing blew up/);
    expect(freeClientSession).toHaveBeenCalledWith(77);
  });
});
