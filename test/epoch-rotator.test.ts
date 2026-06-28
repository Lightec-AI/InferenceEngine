import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockProvider } from "../src/crypto/provider.js";
import { createEpochRotator } from "../src/engine/epoch-rotator.js";

function ed25519Pair(): { pub: string; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = (publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .subarray(-32)
    .toString("base64url");
  return { pub, priv: privateKey };
}

describe("epoch rotator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts ephemeral to all live sessions on registerInitialEpoch", async () => {
    const provider = createMockProvider();
    const { pub, priv } = ed25519Pair();
    const posted: string[] = [];
    const rotator = createEpochRotator({
      engineId: "eng-rot",
      ed25519PublicB64: pub,
      ed25519PrivateKey: priv,
      provider,
      policy: { rotationIntervalMs: 86_400_000, overlapGraceMs: 0 },
      listSessions: () => [
        {
          session: {
            closed: false,
            destroyed: false,
            request: () => {
              throw new Error("unused");
            },
          } as never,
          sessionId: "s1",
        },
      ],
    });

    const original = await import("../src/engine-plane/pool-client.js");
    vi.spyOn(original, "postEphemeralOnAttestedSession").mockResolvedValue({
      status: 201,
      json: {},
    });

    await rotator.registerInitialEpoch();
    expect(original.postEphemeralOnAttestedSession).toHaveBeenCalled();
    posted.push(rotator.currentEpoch().epochId);
    expect(posted[0]).toMatch(/^epoch-/);
    rotator.stop();
  });

  it("schedules rotation before not_after via lead time", async () => {
    vi.useFakeTimers();
    const provider = createMockProvider();
    const { pub, priv } = ed25519Pair();
    const rotated: string[] = [];
    const rotator = createEpochRotator({
      engineId: "eng-sched",
      ed25519PublicB64: pub,
      ed25519PrivateKey: priv,
      provider,
      policy: { rotationIntervalMs: 10_000, overlapGraceMs: 0 },
      rotationLeadMs: 2_000,
      listSessions: () => [
        {
          session: { closed: false, destroyed: false } as never,
          sessionId: "s1",
        },
      ],
      onEpochRotated: (epoch) => rotated.push(epoch.epochId),
      setTimeoutFn: vi.fn((fn, ms) => setTimeout(fn, ms)) as typeof setTimeout,
      clearTimeoutFn: clearTimeout,
    });

    const poolClient = await import("../src/engine-plane/pool-client.js");
    vi.spyOn(poolClient, "postEphemeralOnAttestedSession").mockResolvedValue({
      status: 201,
      json: {},
    });

    await rotator.registerInitialEpoch();
    rotator.start();
    const firstId = rotator.currentEpoch().epochId;

    await vi.advanceTimersByTimeAsync(9_000);
    expect(rotated.length).toBeGreaterThan(0);
    expect(rotator.currentEpoch().epochId).not.toBe(firstId);
    rotator.stop();
  });

  it("uses refreshed attestation on later epoch rotations", async () => {
    const provider = createMockProvider();
    const { pub, priv } = ed25519Pair();
    const { buildMockAttestationBundle } = await import("../src/testing/mock-keys.js");
    const stale = buildMockAttestationBundle({
      ed25519Public: pub,
      tlsClientCertSha256: "aa".repeat(32),
    });
    const fresh = buildMockAttestationBundle({
      ed25519Public: pub,
      tlsClientCertSha256: "aa".repeat(32),
    });
    const rotator = createEpochRotator({
      engineId: "eng-att",
      ed25519PublicB64: pub,
      ed25519PrivateKey: priv,
      attestation: stale,
      provider,
      policy: { rotationIntervalMs: 86_400_000, overlapGraceMs: 0 },
      listSessions: () => [
        {
          session: { closed: false, destroyed: false } as never,
          sessionId: "s1",
        },
      ],
    });

    const poolClient = await import("../src/engine-plane/pool-client.js");
    vi.spyOn(poolClient, "postEphemeralOnAttestedSession").mockResolvedValue({
      status: 201,
      json: {},
    });

    rotator.setAttestation(fresh);
    await rotator.rotateNow();
    expect(rotator.currentEpoch().ephemeralRequest.attestation).toBe(fresh);
    rotator.stop();
  });
});
