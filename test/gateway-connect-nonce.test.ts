import { describe, expect, it } from "vitest";

import { buildMockCpuQuote, type MockCpuQuotePayload } from "../src/attestation.js";
import {
  generateGatewayConnectChallengeNonce,
  isValidGatewayConnectChallengeNonce,
  normalizeGatewayConnectChallengeNonce,
  verifyGatewayConnectChallengeInBundle,
} from "../src/engine/gateway-connect-nonce.js";
import type { AttestationBundle } from "../src/protocol/types.js";

describe("gateway connect challenge nonce", () => {
  it("generates 128-bit hex nonces", () => {
    const nonce = generateGatewayConnectChallengeNonce();
    expect(isValidGatewayConnectChallengeNonce(nonce)).toBe(true);
    expect(nonce).toHaveLength(32);
  });

  it("normalizes valid nonces", () => {
    expect(normalizeGatewayConnectChallengeNonce("ABCDEF0123456789ABCDEF0123456789")).toBe(
      "abcdef0123456789abcdef0123456789",
    );
    expect(normalizeGatewayConnectChallengeNonce("short")).toBeUndefined();
    expect(normalizeGatewayConnectChallengeNonce("")).toBeUndefined();
  });

  it("verifies mock quote nonce binding", () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const payload: MockCpuQuotePayload & { nonce: string } = {
      v: 1,
      kind: "tdx",
      ed25519_public: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tls_client_cert_sha256: "",
      engine: { version: "1.0.0", binary_sha256: "a".repeat(64) },
      vllm: { version: "1.0.0", binary_sha256: "b".repeat(64) },
      issued_at: new Date().toISOString(),
      nonce,
    };
    const bundle: AttestationBundle = {
      cpu_tee: { kind: "tdx", quote: buildMockCpuQuote(payload), verdict: "pass" },
      gpu_tee: { kind: "nv-cc", evidence: "Zmock", verdict: "pass" },
      engine: payload.engine,
      vllm: payload.vllm,
    };
    expect(verifyGatewayConnectChallengeInBundle(bundle, nonce)).toBe(true);
    expect(verifyGatewayConnectChallengeInBundle(bundle, "f".repeat(32))).toBe(false);
  });
});
