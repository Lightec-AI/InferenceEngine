import { describe, expect, it } from "vitest";

import { verifyAttestedConnectAttestation } from "../attestation.js";
import { generateMockEngineKeys } from "../testing/mock-keys.js";
import { buildAttestedConnectRequest } from "../testing/mock-keys.js";

describe("verifyAttestedConnectAttestation", () => {
  it("accepts mock connect without mTLS cert binding", () => {
    const material = generateMockEngineKeys({
      engineId: "engine-a",
      models: ["llama3"],
      inferenceBaseUrl: "unused",
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
