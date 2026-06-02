import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROWSER_TEST_ATTESTATION_POLICY,
  verifyEngineTrustBundleBrowser,
} from "../src/browser-trust.js";
import { generateMockEngineKeys, generateMockEphemeralEpoch } from "../src/testing/mock-keys.js";

describe("verifyEngineTrustBundleBrowser", () => {
  it("accepts mock trust bundle from testing fixtures", async () => {
    const material = generateMockEngineKeys({
      engineId: "eng-browser",
      models: ["m"],
      tlsClientCertSha256: "abc123cert",
    });
    const epoch = generateMockEphemeralEpoch({ engineId: "eng-browser", material });
    const bundle = {
      engine_id: "eng-browser",
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

    const r = await verifyEngineTrustBundleBrowser(
      bundle,
      DEFAULT_BROWSER_TEST_ATTESTATION_POLICY,
      material.tlsClientCertSha256,
      Date.now(),
      { skipTlsCertBinding: true },
    );
    expect(r.ok).toBe(true);
  });
});
