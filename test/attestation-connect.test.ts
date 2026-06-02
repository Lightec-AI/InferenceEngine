import { describe, expect, it } from "vitest";

import { verifyAttestedConnectAttestation } from "../src/attestation.js";
import { buildAttestedConnectRequest, generateMockEngineKeys } from "../src/testing/mock-keys.js";

describe("verifyAttestedConnectAttestation", () => {
  it("accepts mock connect without mTLS cert binding", () => {
    const material = generateMockEngineKeys({
      engineId: "engine-a",
      models: ["llama3"],
    });
    const connect = buildAttestedConnectRequest({
      material,
      sessionId: "session-1",
      poolTargetSize: 2,
    });
    const verdict = verifyAttestedConnectAttestation(connect);
    expect(verdict.ok).toBe(true);
  });
});
