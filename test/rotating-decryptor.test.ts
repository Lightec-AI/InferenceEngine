import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createMockProvider } from "../src/crypto/provider.js";
import { createEngineEpoch, disposeEngineEpoch } from "../src/engine/epoch.js";
import { createRotatingEpochDecryptor } from "../src/engine/rotating-decryptor.js";
import type { OpeEnvelope } from "../src/protocol/types.js";

function ed25519Pair(): { pub: string; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = (publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .subarray(-32)
    .toString("base64url");
  return { pub, priv: privateKey };
}

describe("rotating epoch decryptor", () => {
  it("tracks current handle and resolves by envelope epoch id", () => {
    const provider = createMockProvider();
    const { pub, priv } = ed25519Pair();
    const epochA = createEngineEpoch({
      engineId: "eng",
      ed25519PublicB64: pub,
      ed25519PrivateKey: priv,
      epochId: "epoch-a",
      provider,
    });
    const decryptor = createRotatingEpochDecryptor(epochA, 0);
    expect(decryptor.currentEpochId()).toBe("epoch-a");

    const epochB = createEngineEpoch({
      engineId: "eng",
      ed25519PublicB64: pub,
      ed25519PrivateKey: priv,
      epochId: "epoch-b",
      provider,
    });
    decryptor.addEpoch(epochB);
    expect(decryptor.currentEpochId()).toBe("epoch-b");

    const envelope = {
      e2e: { ephemeral_epoch: "epoch-a" },
    } as OpeEnvelope;
    if (epochA.handle != null) {
      expect(decryptor.resolveHandle(envelope)).toBe(epochA.handle);
    }

    disposeEngineEpoch(epochA);
    disposeEngineEpoch(epochB);
  });

  it("prunes retired epochs after overlap grace", () => {
    const provider = createMockProvider();
    const { pub, priv } = ed25519Pair();
    const epochA = createEngineEpoch({
      engineId: "eng",
      ed25519PublicB64: pub,
      ed25519PrivateKey: priv,
      epochId: "epoch-a",
      ttlMs: 1,
      provider,
    });
    const decryptor = createRotatingEpochDecryptor(epochA, 0);
    const epochB = createEngineEpoch({
      engineId: "eng",
      ed25519PublicB64: pub,
      ed25519PrivateKey: priv,
      epochId: "epoch-b",
      provider,
    });
    decryptor.addEpoch(epochB);
    decryptor.pruneRetired(Date.parse(epochA.notAfter) + 1, 0);
    expect(() =>
      decryptor.resolveHandle({ e2e: { ephemeral_epoch: "epoch-a" } } as OpeEnvelope),
    ).toThrow(/no decrypt handle/);
    disposeEngineEpoch(epochB);
  });
});
