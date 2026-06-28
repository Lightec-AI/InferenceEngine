import { afterEach, describe, expect, it, vi } from "vitest";

import { parseMockCpuQuote } from "../src/attestation.js";
import { createEngineAttestationRefresher } from "../src/engine/attestation-refresh.js";
import { generateMockEngineKeys } from "../src/testing/mock-keys.js";

describe("createEngineAttestationRefresher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mints a fresh mock quote on each call", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const material = generateMockEngineKeys({
      engineId: "eng-refresh",
      models: ["m@teechat"],
    });
    const refresh = createEngineAttestationRefresher({
      ed25519Public: material.ed25519Public,
      tlsClientCertSha256: material.tlsClientCertSha256,
      useSevSnp: false,
    });

    const first = refresh();
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    const second = refresh();
    const firstClaims = parseMockCpuQuote(first.cpu_tee.quote);
    const secondClaims = parseMockCpuQuote(second.cpu_tee.quote);

    expect(firstClaims?.issued_at).toBe("2026-01-01T00:00:00.000Z");
    expect(secondClaims?.issued_at).toBe("2026-01-02T00:00:00.000Z");
    expect(first.cpu_tee.quote).not.toBe(second.cpu_tee.quote);
    expect(firstClaims?.ed25519_public).toBe(material.ed25519Public);
    expect(secondClaims?.ed25519_public).toBe(material.ed25519Public);
  });
});
