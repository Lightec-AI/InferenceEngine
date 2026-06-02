import { describe, expect, it } from "vitest";

import {
  buildMockCpuQuote,
  DEFAULT_TEST_ATTESTATION_POLICY,
  verifyPlatformAttestationBundle,
  type PlatformAttestationPolicy,
} from "../src/attestation.js";
import { buildMockAttestationBundle } from "../src/testing/mock-keys.js";

function gatewayPlatformBundle(gw: string, ed: string) {
  const bundle = buildMockAttestationBundle({ ed25519Public: ed, tlsClientCertSha256: "" });
  const engine = { version: "1.0", binary_sha256: gw };
  const vllm = { version: "1.0", binary_sha256: gw };
  bundle.cpu_tee.quote = buildMockCpuQuote({
    v: 1,
    kind: "tdx",
    ed25519_public: ed,
    tls_client_cert_sha256: "",
    engine,
    vllm,
    issued_at: new Date().toISOString(),
  });
  bundle.engine = engine;
  bundle.vllm = vllm;
  return bundle;
}

describe("verifyPlatformAttestationBundle", () => {
  it("accepts gateway measurement in platform allowlist", () => {
    const gw = "c3d4e5f6789012345678abcdef9012345678abcdef9012345678abcdef901234";
    const ed = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const bundle = gatewayPlatformBundle(gw, ed);

    const platform: PlatformAttestationPolicy = {
      policyId: "teechat-cpu-tee-v1",
      allowedGatewayBinarySha256: new Set([gw]),
      allowedSkillHubBinarySha256: new Set([gw]),
      maxQuoteAgeMs: 86400000,
    };

    const verdict = verifyPlatformAttestationBundle(
      bundle,
      DEFAULT_TEST_ATTESTATION_POLICY,
      platform,
      { gatewayBinarySha256: gw, skillHubBinarySha256: gw, ed25519Public: ed },
    );
    expect(verdict.ok).toBe(true);
  });

  it("rejects gateway hash not in platform allowlist", () => {
    const gw = "c3d4e5f6789012345678abcdef9012345678abcdef9012345678abcdef901234";
    const ed = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const bundle = gatewayPlatformBundle(gw, ed);

    const platform: PlatformAttestationPolicy = {
      policyId: "teechat-cpu-tee-v1",
      allowedGatewayBinarySha256: new Set(["aa".repeat(32)]),
      allowedSkillHubBinarySha256: new Set(["aa".repeat(32)]),
      maxQuoteAgeMs: 86400000,
    };

    const verdict = verifyPlatformAttestationBundle(
      bundle,
      DEFAULT_TEST_ATTESTATION_POLICY,
      platform,
      { gatewayBinarySha256: gw, skillHubBinarySha256: gw, ed25519Public: ed },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("gateway_hash_not_allowed");
  });
});
