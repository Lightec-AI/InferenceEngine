import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadOpeFfi } from "../src/native/ope-ffi.js";
import {
  DEV_VECTOR_001_SECRET_SEED,
  devVector001PublicKey,
  signEnvelopeWithSecretKey,
  verifyGatewayOpaqueEnvelope,
} from "../src/native/envelope-ffi.js";
import {
  generateMockEngineKeys,
  generateMockEphemeralEpoch,
} from "../src/testing/index.js";

const ffiScript = resolve(import.meta.dirname, "..", "scripts", "build-ope-ffi.mjs");

/** Placeholder hash for opaque `e2e-hybrid-pq` envelopes (gateway does not verify payload body). */
const OPAQUE_E2E_PAYLOAD_HASH =
  "IfBq5V-pFYBzzfW2K3S-zNKdsplvqUQW5rzB9Y-K5R4";

function ensureFfi(): void {
  if (loadOpeFfi()) return;
  if (!existsSync(ffiScript)) throw new Error("missing build-ope-ffi script");
  execFileSync(process.execPath, [ffiScript], { stdio: "ignore" });
  if (!loadOpeFfi()) throw new Error("ope-ffi not available after build");
}

function signedOpaqueEnvelope(recipient: string): Record<string, unknown> {
  const material = generateMockEngineKeys({ engineId: "engine-a", models: ["m"] });
  const epoch = generateMockEphemeralEpoch({ engineId: "engine-a", material });
  return JSON.parse(
    signEnvelopeWithSecretKey(DEV_VECTOR_001_SECRET_SEED, {
      ope_version: "1.0",
      alg: "EdDSA",
      enc: "e2e-hybrid-pq",
      kid: "user-1",
      recipient,
      ts: new Date().toISOString(),
      nonce: randomUUID(),
      payload_hash: OPAQUE_E2E_PAYLOAD_HASH,
      engine_id: "engine-a",
      ciphertext: "opaque",
      iv: "iv",
      e2e: {
        kex: "X25519MLKEM768",
        engine_mlkem_encap: epoch.hybrid.mlkem_encapsulation_key,
        engine_x25519: epoch.hybrid.x25519_public,
        ephemeral_epoch: epoch.epochId,
      },
    }),
  ) as Record<string, unknown>;
}

describe("envelope-ffi gateway opaque", () => {
  it("signs and verifies opaque e2e envelopes", () => {
    ensureFfi();
    const pk = devVector001PublicKey();
    const signed = signedOpaqueEnvelope("teechat-gateway");
    expect(() =>
      verifyGatewayOpaqueEnvelope(pk, signed, { recipient: "teechat-gateway" }),
    ).not.toThrow();
  });

  it("rejects wrong recipient", () => {
    ensureFfi();
    const pk = devVector001PublicKey();
    const signed = signedOpaqueEnvelope("other-gateway");
    expect(() =>
      verifyGatewayOpaqueEnvelope(pk, signed, { recipient: "teechat-gateway" }),
    ).toThrow();
  });
});
