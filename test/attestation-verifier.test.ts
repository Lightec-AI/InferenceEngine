import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEST_ATTESTATION_POLICY,
  MockCpuQuoteVerifier,
  ProductionCpuQuoteVerifier,
  parseMockCpuQuote,
  resolveCpuQuoteVerifier,
  verifyAttestationBundle,
} from "../src/attestation.js";
import { generateMockEngineKeys } from "../src/testing/index.js";

function fixture() {
  const material = generateMockEngineKeys({
    engineId: "engine-attest",
    models: ["llama3"],
    inferenceBaseUrl: "",
    tlsClientCertSha256: "attest-cert",
  });
  return {
    bundle: material.registerRequest.attestation,
    bind: {
      ed25519Public: material.ed25519Public,
      tlsClientCertSha256: material.tlsClientCertSha256,
    },
  };
}

describe("attestation verifier seam", () => {
  it("resolves a mock verifier in development and production verifier otherwise", () => {
    expect(resolveCpuQuoteVerifier({ NODE_ENV: "development" }).kind).toBe("mock");
    expect(resolveCpuQuoteVerifier({ TEECHAT_BUILD: "production" }).kind).toBe("production");
  });

  it("verifies a valid bundle with the mock verifier", () => {
    const { bundle, bind } = fixture();
    const result = verifyAttestationBundle(
      bundle,
      DEFAULT_TEST_ATTESTATION_POLICY,
      bind,
      Date.now(),
      new MockCpuQuoteVerifier(),
    );
    expect(result.ok).toBe(true);
  });

  it("fails closed in production when no backend is configured", () => {
    const { bundle, bind } = fixture();
    const result = verifyAttestationBundle(
      bundle,
      DEFAULT_TEST_ATTESTATION_POLICY,
      bind,
      Date.now(),
      new ProductionCpuQuoteVerifier(null),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/attestation_backend_error/);
  });

  it("verifies via a registered production backend", () => {
    const { bundle, bind } = fixture();
    // A real backend would parse TDX/SEV-SNP; here it validates the mock quote to stand in.
    const backend = new ProductionCpuQuoteVerifier((quote) => parseMockCpuQuote(quote));
    const result = verifyAttestationBundle(
      bundle,
      DEFAULT_TEST_ATTESTATION_POLICY,
      bind,
      Date.now(),
      backend,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered quote even via the production backend", () => {
    const { bundle, bind } = fixture();
    const tampered = { ...bundle, cpu_tee: { ...bundle.cpu_tee, quote: `${bundle.cpu_tee.quote}AA` } };
    const backend = new ProductionCpuQuoteVerifier((quote) => parseMockCpuQuote(quote));
    const result = verifyAttestationBundle(
      tampered,
      DEFAULT_TEST_ATTESTATION_POLICY,
      bind,
      Date.now(),
      backend,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_cpu_quote");
  });
});
