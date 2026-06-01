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

const ffiScript = resolve(import.meta.dirname, "..", "scripts", "build-ope-ffi.mjs");

function ensureFfi(): void {
  if (loadOpeFfi()) return;
  if (!existsSync(ffiScript)) throw new Error("missing build-ope-ffi script");
  execFileSync(process.execPath, [ffiScript], { stdio: "ignore" });
  if (!loadOpeFfi()) throw new Error("ope-ffi not available after build");
}

describe("envelope-ffi gateway opaque", () => {
  it("signs and verifies opaque e2e envelopes", () => {
    ensureFfi();
    const pk = devVector001PublicKey();
    const ts = new Date().toISOString();
    const signed = JSON.parse(
      signEnvelopeWithSecretKey(DEV_VECTOR_001_SECRET_SEED, {
        ope_version: "1.0",
        alg: "EdDSA",
        enc: "e2e-hybrid-pq",
        kid: "user-1",
        recipient: "teechat-gateway",
        ts,
        nonce: randomUUID(),
        payload_hash: "IfBq5V-pFYBzzfW2K3S-zNKdsplvqUQW5rzB9Y-K5R4",
        engine_id: "engine-a",
        ciphertext: "opaque",
      }),
    ) as Record<string, unknown>;
    expect(() =>
      verifyGatewayOpaqueEnvelope(pk, signed, { recipient: "teechat-gateway" }),
    ).not.toThrow();
  });

  it("rejects wrong recipient", () => {
    ensureFfi();
    const pk = devVector001PublicKey();
    const signed = JSON.parse(
      signEnvelopeWithSecretKey(DEV_VECTOR_001_SECRET_SEED, {
        ope_version: "1.0",
        alg: "EdDSA",
        enc: "e2e-hybrid-pq",
        kid: "user-1",
        recipient: "other-gateway",
        ts: new Date().toISOString(),
        nonce: randomUUID(),
        payload_hash: "",
      }),
    ) as Record<string, unknown>;
    expect(() =>
      verifyGatewayOpaqueEnvelope(pk, signed, { recipient: "teechat-gateway" }),
    ).toThrow();
  });
});
