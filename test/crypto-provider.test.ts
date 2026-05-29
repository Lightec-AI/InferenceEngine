import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { mockAllowed, resolveBuildMode } from "../src/build-mode.js";
import {
  createMockProvider,
  createRealProvider,
  resolveCryptoProvider,
} from "../src/crypto/provider.js";
import { MOCK_MLKEM_ENCAP_B64URL_LEN } from "../src/protocol/types.js";

describe("build mode", () => {
  it("treats production as production and forbids mocks", () => {
    expect(resolveBuildMode({ TEECHAT_BUILD: "production" })).toBe("production");
    expect(resolveBuildMode({ NODE_ENV: "production" })).toBe("production");
    expect(mockAllowed({ TEECHAT_BUILD: "production" })).toBe(false);
  });
  it("allows mocks in development unless forced real", () => {
    expect(mockAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(mockAllowed({ NODE_ENV: "development", TEECHAT_FORCE_REAL_CRYPTO: "1" })).toBe(false);
  });
});

describe("crypto provider selection", () => {
  it("returns a mock provider when explicitly requested in dev", () => {
    const p = resolveCryptoProvider({ TEECHAT_CRYPTO: "mock", NODE_ENV: "development" }, { fresh: true });
    expect(p.mode).toBe("mock");
  });

  it("refuses mock in production", () => {
    expect(() =>
      resolveCryptoProvider({ TEECHAT_CRYPTO: "mock", NODE_ENV: "production" }, { fresh: true }),
    ).toThrow(/not permitted/);
  });

  it("selects the real provider in production (native library present in CI)", () => {
    const p = resolveCryptoProvider({ TEECHAT_BUILD: "production" }, { fresh: true });
    expect(p.mode).toBe("real");
  });
});

describe("mock provider", () => {
  it("produces correctly-sized public material but cannot decrypt", () => {
    const p = createMockProvider();
    const { hybrid, handle } = p.generateEngineHybrid("engine-x", "irrelevant");
    expect(handle).toBeNull();
    expect(hybrid.kex).toBe("X25519MLKEM768");
    expect(hybrid.mlkem_encapsulation_key.length).toBe(MOCK_MLKEM_ENCAP_B64URL_LEN);
    expect(() => p.decryptRequest(0, {})).toThrow(/cannot decrypt/);
  });
});

describe("real provider roundtrip", () => {
  it("encrypts and decrypts a request through the provider", () => {
    const provider = createRealProvider();
    const ed = testEd25519();
    const { handle, hybrid } = provider.generateEngineHybrid("engine-provider", ed);
    const identity = {
      engine_id: "engine-provider",
      kex: hybrid.kex,
      mlkem_encapsulation_key: hybrid.mlkem_encapsulation_key,
      x25519_public: hybrid.x25519_public,
      ed25519_public: ed,
    };
    const payload = { model: "m@teechat", messages: [{ role: "user", content: "hello" }] };
    const { envelope } = provider.clientEncryptRequest(identity, payload, baseEnvelope(), false);
    const decrypted = provider.decryptRequest(handle!, envelope);
    expect(decrypted).toEqual(payload);
    provider.freeEngine(handle!);
  });
});

function testEd25519(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return (publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .subarray(-32)
    .toString("base64url");
}

function baseEnvelope() {
  return {
    ope_version: "1.0",
    alg: "EdDSA",
    enc: "none",
    kid: "user-1",
    recipient: "teechat-gateway",
    ts: new Date().toISOString(),
    nonce: `nonce-${Math.random().toString(36).slice(2)}`,
    payload_hash: "",
  };
}
