import { describe, expect, it } from "vitest";

import { DEFAULT_TEST_ATTESTATION_POLICY } from "../src/attestation.js";
import { parseAttestationPolicyJson } from "../src/attestation-policy-file.js";

describe("attestation-policy-file", () => {
  it("parses staging-shaped policy JSON", () => {
    const policy = parseAttestationPolicyJson({
      policyId: "teechat-cpu-tee-v1",
      allowedEngineBinarySha256: [
        "a1b2c3d4e5f6789012345678abcdef9012345678abcdef9012345678abcdef90",
      ],
      allowedVllmBinarySha256: [
        "b2c3d4e5f6789012345678abcdef9012345678abcdef9012345678abcdef9012",
      ],
      maxQuoteAgeMs: 86400000,
    });
    expect(policy.policyId).toBe("teechat-cpu-tee-v1");
    expect(policy.allowedEngineBinarySha256.size).toBe(1);
    expect(policy.maxQuoteAgeMs).toBe(86400000);
  });

  it("matches DEFAULT_TEST allowlists when using fixture hashes", () => {
    const policy = parseAttestationPolicyJson({
      policyId: DEFAULT_TEST_ATTESTATION_POLICY.policyId,
      allowedEngineBinarySha256: [...DEFAULT_TEST_ATTESTATION_POLICY.allowedEngineBinarySha256],
      allowedVllmBinarySha256: [...DEFAULT_TEST_ATTESTATION_POLICY.allowedVllmBinarySha256],
      maxQuoteAgeMs: DEFAULT_TEST_ATTESTATION_POLICY.maxQuoteAgeMs,
    });
    expect(policy.allowedEngineBinarySha256).toEqual(
      DEFAULT_TEST_ATTESTATION_POLICY.allowedEngineBinarySha256,
    );
  });

  it("rejects invalid JSON shape", () => {
    expect(() => parseAttestationPolicyJson({ policyId: "" })).toThrow(/policyId/);
  });
});
