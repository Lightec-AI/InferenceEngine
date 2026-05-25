import { describe, expect, it } from "vitest";

import {
  buildMockCpuQuote,
  DEFAULT_TEST_ATTESTATION_POLICY,
  parseMockCpuQuote,
  verifyAttestationBundle,
  verifyRegisterAttestation,
} from "../src/attestation.js";
import { generateMockEngineKeys } from "../src/testing/mock-keys.js";

describe("attestation", () => {
  it("round-trips mock CPU quote", () => {
    const material = generateMockEngineKeys({
      engineId: "e1",
      models: ["llama3"],
      inferenceBaseUrl: "https://engine",
    });
    const quote = material.registerRequest.attestation.cpu_tee.quote;
    const parsed = parseMockCpuQuote(quote);
    expect(parsed?.ed25519_public).toBe(material.ed25519Public);
  });

  it("rejects tampered quote", () => {
    const material = generateMockEngineKeys({
      engineId: "e1",
      models: ["llama3"],
      inferenceBaseUrl: "https://engine",
    });
    const bad = buildMockCpuQuote({
      v: 1,
      kind: "tdx",
      ed25519_public: "wrong",
      tls_client_cert_sha256: material.tlsClientCertSha256,
      engine: material.registerRequest.attestation.engine,
      vllm: material.registerRequest.attestation.vllm,
      issued_at: new Date().toISOString(),
    });
    const bundle = { ...material.registerRequest.attestation, cpu_tee: { ...material.registerRequest.attestation.cpu_tee, quote: bad } };
    const result = verifyAttestationBundle(bundle, DEFAULT_TEST_ATTESTATION_POLICY, {
      ed25519Public: material.ed25519Public,
      tlsClientCertSha256: material.tlsClientCertSha256,
    });
    expect(result.ok).toBe(false);
  });

  it("verifyRegisterAttestation passes for mock engine", () => {
    const material = generateMockEngineKeys({
      engineId: "e1",
      models: ["llama3"],
      inferenceBaseUrl: "https://engine",
    });
    const result = verifyRegisterAttestation(
      material.registerRequest,
      material.tlsClientCertSha256,
    );
    expect(result.ok).toBe(true);
  });
});
