import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ephemeralSigningBytes, verifyEphemeralIdentitySignature } from "../src/ephemeral.js";
import { generateMockEngineKeys, generateMockEphemeralEpoch } from "../src/testing/mock-keys.js";

describe("ephemeral signatures", () => {
  it("verifyEphemeralIdentitySignature accepts mock epoch", () => {
    const material = generateMockEngineKeys({
      engineId: "e1",
      models: ["m"],
      inferenceBaseUrl: "https://x",
    });
    const epoch = generateMockEphemeralEpoch({ engineId: "e1", material });
    expect(
      verifyEphemeralIdentitySignature(material.ed25519Public, epoch.ephemeralRequest),
    ).toBe(true);
  });

  it("rejects wrong signer", () => {
    const material = generateMockEngineKeys({
      engineId: "e1",
      models: ["m"],
      inferenceBaseUrl: "https://x",
    });
    const other = generateKeyPairSync("ed25519");
    const epoch = generateMockEphemeralEpoch({ engineId: "e1", material });
    const badSig = sign(
      null,
      ephemeralSigningBytes({
        engineId: "e1",
        epochId: epoch.epochId,
        notAfter: epoch.notAfter,
        hybrid: epoch.hybrid,
      }),
      other.privateKey,
    ).toString("base64url");
    expect(
      verifyEphemeralIdentitySignature(material.ed25519Public, {
        ...epoch.ephemeralRequest,
        identity_signature: badSig,
      }),
    ).toBe(false);
  });
});
