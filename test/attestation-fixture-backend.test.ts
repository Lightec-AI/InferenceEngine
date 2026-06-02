import { describe, expect, it } from "vitest";

import {
  ProductionCpuQuoteVerifier,
  buildMockCpuQuote,
  clearProductionQuoteBackend,
  registerProductionQuoteBackend,
} from "../src/attestation.js";
import {
  FIXTURE_INTEL_TDX_QUOTE_PLACEHOLDER,
  createFixtureProductionQuoteBackend,
} from "../src/attestation-fixture-backend.js";

describe("attestation-fixture-backend", () => {
  it("extracts claims for placeholder Intel fixture quote", () => {
    registerProductionQuoteBackend(createFixtureProductionQuoteBackend());
    const verifier = new ProductionCpuQuoteVerifier();
    const claims = verifier.extractClaims(FIXTURE_INTEL_TDX_QUOTE_PLACEHOLDER, "tdx");
    expect(claims?.kind).toBe("tdx");
    expect(claims?.engine.binary_sha256).toMatch(/^[a-f0-9]{64}$/);
    clearProductionQuoteBackend();
  });

  it("accepts valid HMAC mock quotes via fallback", () => {
    const payload = {
      v: 1 as const,
      kind: "tdx" as const,
      ed25519_public: "pub",
      tls_client_cert_sha256: "",
      engine: { version: "1", binary_sha256: "a".repeat(64) },
      vllm: { version: "1", binary_sha256: "b".repeat(64) },
      issued_at: new Date().toISOString(),
    };
    const quote = buildMockCpuQuote(payload);
    registerProductionQuoteBackend(createFixtureProductionQuoteBackend(new Set()));
    const verifier = new ProductionCpuQuoteVerifier();
    expect(verifier.extractClaims(quote, "tdx")?.ed25519_public).toBe("pub");
    clearProductionQuoteBackend();
  });
});
