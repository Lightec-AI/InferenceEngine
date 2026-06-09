import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROWSER_TEST_ATTESTATION_POLICY,
  verifyEngineTrustBundleBrowserDetailed,
} from "../src/browser-trust.js";
import {
  buildMockAttestationBundle,
  generateMockEngineKeys,
  generateMockEphemeralEpoch,
} from "../src/testing/mock-keys.js";

describe("browser-trust", () => {
  it("reports Intel signer for TDX mock attestation", async () => {
    const material = generateMockEngineKeys({ engineId: "e-tdx", models: ["m"] });
    const epoch = generateMockEphemeralEpoch({ engineId: "e-tdx", material });
    const bundle = {
      engine_id: "e-tdx",
      epoch_id: epoch.epochId,
      not_before: epoch.notBefore,
      not_after: epoch.notAfter,
      hybrid: epoch.hybrid,
      identity: {
        ed25519_public: material.ed25519Public,
        identity_signature: epoch.ephemeralRequest.identity_signature,
      },
      attestation: material.registerRequest.attestation,
      gateway_cached_at: new Date().toISOString(),
    };

    const result = await verifyEngineTrustBundleBrowserDetailed(
      bundle,
      DEFAULT_BROWSER_TEST_ATTESTATION_POLICY,
      material.tlsClientCertSha256,
      Date.now(),
      { skipTlsCertBinding: true },
    );

    expect(result.ok).toBe(true);
    expect(result.evidence?.signatures.some((s) => s.signer === "intel")).toBe(true);
    expect(result.evidence?.signatures.some((s) => s.signer === "amd")).toBe(false);
  });

  it("reports AMD signer for SEV-SNP mock attestation", async () => {
    const material = generateMockEngineKeys({ engineId: "e-sev", models: ["m"] });
    const epoch = generateMockEphemeralEpoch({ engineId: "e-sev", material });
    const sevAttestation = buildMockAttestationBundle({
      ed25519Public: material.ed25519Public,
      tlsClientCertSha256: material.tlsClientCertSha256,
      cpuKind: "sev-snp",
    });
    const bundle = {
      engine_id: "e-sev",
      epoch_id: epoch.epochId,
      not_before: epoch.notBefore,
      not_after: epoch.notAfter,
      hybrid: epoch.hybrid,
      identity: {
        ed25519_public: material.ed25519Public,
        identity_signature: epoch.ephemeralRequest.identity_signature,
      },
      attestation: sevAttestation,
      gateway_cached_at: new Date().toISOString(),
    };

    const result = await verifyEngineTrustBundleBrowserDetailed(
      bundle,
      DEFAULT_BROWSER_TEST_ATTESTATION_POLICY,
      material.tlsClientCertSha256,
      Date.now(),
      { skipTlsCertBinding: true },
    );

    expect(result.ok).toBe(true);
    const amd = result.evidence?.signatures.find((s) => s.signer === "amd");
    expect(amd?.status).toBe("mock_dev");
    expect(amd?.algorithm).toContain("SEV-SNP");
    expect(result.evidence?.cpuKind).toBe("sev-snp");
  });
});
