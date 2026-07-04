import type { ClientHttp2Session } from "node:http2";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockProvider } from "../src/crypto/provider.js";
import { createSupervisedEnginePlanePool } from "../src/engine/supervised-pool.js";
import { buildAttestedConnectRequest, generateMockEngineKeys } from "../src/testing/mock-keys.js";

function fakeSession(): ClientHttp2Session {
  const handlers = new Map<string, Array<() => void>>();
  return {
    closed: false,
    destroyed: false,
    on(event: string, handler: () => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    removeListener(event: string, handler: () => void) {
      const list = handlers.get(event) ?? [];
      handlers.set(
        event,
        list.filter((h) => h !== handler),
      );
    },
    close() {
      this.closed = true;
      for (const handler of handlers.get("close") ?? []) handler();
    },
  } as unknown as ClientHttp2Session;
}

function mockPoolClient(busyAfter = 0) {
  let busyCount = 0;
  return {
    async mock() {
      const poolClient = await import("../src/engine-plane/pool-client.js");
      vi.spyOn(poolClient, "openPooledConnection").mockImplementation(async () => fakeSession());
      vi.spyOn(poolClient, "postEphemeralOnAttestedSession").mockResolvedValue({
        status: 201,
        json: {},
      });
      vi.spyOn(poolClient, "gracefulDisconnectAttestedSession").mockResolvedValue(undefined);
      vi.spyOn(poolClient, "startPullWorker").mockImplementation(() => {
        const busy = busyCount < busyAfter;
        busyCount += 1;
        return {
          stop: () => undefined,
          isBusy: () => busy,
        };
      });
      return poolClient;
    },
  };
}

async function createTestPool(opts: {
  poolTargetSize: number;
  poolInitialFraction?: number;
  busySessions?: number;
}) {
  const material = generateMockEngineKeys({
    engineId: "eng-cutover",
    models: ["m@teechat"],
  });
  const provider = createMockProvider();
  await mockPoolClient(opts.busySessions ?? 0).mock();

  const pool = await createSupervisedEnginePlanePool({
    gatewayBaseUrl: "https://127.0.0.1:8788",
    tls: {
      caCertPem: "ca",
      clientCertPem: "cert",
      clientKeyPem: "key",
      clientCertSha256: material.tlsClientCertSha256,
    },
    connect: buildAttestedConnectRequest({
      material,
      sessionId: "boot-session",
      poolTargetSize: opts.poolTargetSize,
    }),
    poolTargetSize: opts.poolTargetSize,
    poolInitialFraction: opts.poolInitialFraction,
    ed25519PublicB64: material.ed25519Public,
    ed25519PrivateKey: material.ed25519PrivateKey,
    attestation: material.registerRequest.attestation,
    tlsClientCertSha256: material.tlsClientCertSha256,
    attestationRefresh: { useSevSnp: false },
    provider,
  });

  return pool;
}

describe("supervised pool engine blue/green cutover", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("boots green at half pool when poolInitialFraction is 0.5", async () => {
    const poolClient = await import("../src/engine-plane/pool-client.js");
    const pool = await createTestPool({ poolTargetSize: 2, poolInitialFraction: 0.5 });
    expect(pool.sessionIds).toHaveLength(1);
    expect(poolClient.openPooledConnection).toHaveBeenCalledTimes(1);
    await pool.close();
  });

  it("registers ephemeral epoch before pull workers on boot", async () => {
    const poolClient = await import("../src/engine-plane/pool-client.js");
    const callOrder: string[] = [];
    vi.spyOn(poolClient, "openPooledConnection").mockImplementation(async () => fakeSession());
    vi.spyOn(poolClient, "postEphemeralOnAttestedSession").mockImplementation(async () => {
      callOrder.push("ephemeral");
      return { status: 201, json: {} };
    });
    vi.spyOn(poolClient, "gracefulDisconnectAttestedSession").mockResolvedValue(undefined);
    vi.spyOn(poolClient, "startPullWorker").mockImplementation(() => {
      callOrder.push("pull");
      return { stop: () => undefined, isBusy: () => false };
    });

    const material = generateMockEngineKeys({
      engineId: "eng-boot-epoch-order",
      models: ["m@teechat"],
    });
    const pool = await createSupervisedEnginePlanePool({
      gatewayBaseUrl: "https://127.0.0.1:8788",
      tls: {
        caCertPem: "ca",
        clientCertPem: "cert",
        clientKeyPem: "key",
        clientCertSha256: material.tlsClientCertSha256,
      },
      connect: buildAttestedConnectRequest({
        material,
        sessionId: "boot-session",
        poolTargetSize: 2,
      }),
      poolTargetSize: 2,
      poolInitialFraction: 1,
      ed25519PublicB64: material.ed25519Public,
      ed25519PrivateKey: material.ed25519PrivateKey,
      attestation: material.registerRequest.attestation,
      tlsClientCertSha256: material.tlsClientCertSha256,
      attestationRefresh: { useSevSnp: false },
      provider: createMockProvider(),
    });

    const firstPull = callOrder.indexOf("pull");
    const lastEphemeral = callOrder.lastIndexOf("ephemeral");
    expect(firstPull).toBeGreaterThanOrEqual(0);
    expect(lastEphemeral).toBeLessThan(firstPull);
    await pool.close();
  });

  it("throttles boot sessions by default (concurrency 2)", async () => {
    const poolClient = await import("../src/engine-plane/pool-client.js");
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(poolClient, "openPooledConnection").mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight -= 1;
      return fakeSession();
    });
    vi.spyOn(poolClient, "postEphemeralOnAttestedSession").mockResolvedValue({
      status: 201,
      json: {},
    });
    vi.spyOn(poolClient, "gracefulDisconnectAttestedSession").mockResolvedValue(undefined);
    vi.spyOn(poolClient, "startPullWorker").mockImplementation(() => ({
      stop: () => undefined,
      isBusy: () => false,
    }));

    const material = generateMockEngineKeys({
      engineId: "eng-throttled-boot",
      models: ["m@teechat"],
    });
    // Short stagger so concurrency limit is observable (default 150ms > open duration).
    process.env.TEECHAT_ENGINE_POOL_CONNECT_STAGGER_MS = "5";
    const pool = await createSupervisedEnginePlanePool({
      gatewayBaseUrl: "https://127.0.0.1:8788",
      tls: {
        caCertPem: "ca",
        clientCertPem: "cert",
        clientKeyPem: "key",
        clientCertSha256: material.tlsClientCertSha256,
      },
      connect: buildAttestedConnectRequest({
        material,
        sessionId: "boot-session",
        poolTargetSize: 4,
      }),
      poolTargetSize: 4,
      poolInitialFraction: 1,
      ed25519PublicB64: material.ed25519Public,
      ed25519PrivateKey: material.ed25519PrivateKey,
      attestation: material.registerRequest.attestation,
      tlsClientCertSha256: material.tlsClientCertSha256,
      attestationRefresh: { useSevSnp: false },
      provider: createMockProvider(),
    });

    expect(pool.sessionIds).toHaveLength(4);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    await pool.close();
    delete process.env.TEECHAT_ENGINE_POOL_CONNECT_STAGGER_MS;
  });

  it("allows unlimited boot concurrency when configured", async () => {
    const poolClient = await import("../src/engine-plane/pool-client.js");
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(poolClient, "openPooledConnection").mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return fakeSession();
    });
    vi.spyOn(poolClient, "postEphemeralOnAttestedSession").mockResolvedValue({
      status: 201,
      json: {},
    });
    vi.spyOn(poolClient, "gracefulDisconnectAttestedSession").mockResolvedValue(undefined);
    vi.spyOn(poolClient, "startPullWorker").mockImplementation(() => ({
      stop: () => undefined,
      isBusy: () => false,
    }));

    process.env.TEECHAT_ENGINE_POOL_CONNECT_CONCURRENCY = "unlimited";
    process.env.TEECHAT_ENGINE_POOL_CONNECT_STAGGER_MS = "0";
    const material = generateMockEngineKeys({
      engineId: "eng-parallel-boot",
      models: ["m@teechat"],
    });
    const pool = await createSupervisedEnginePlanePool({
      gatewayBaseUrl: "https://127.0.0.1:8788",
      tls: {
        caCertPem: "ca",
        clientCertPem: "cert",
        clientKeyPem: "key",
        clientCertSha256: material.tlsClientCertSha256,
      },
      connect: buildAttestedConnectRequest({
        material,
        sessionId: "boot-session",
        poolTargetSize: 4,
      }),
      poolTargetSize: 4,
      poolInitialFraction: 1,
      ed25519PublicB64: material.ed25519Public,
      ed25519PrivateKey: material.ed25519PrivateKey,
      attestation: material.registerRequest.attestation,
      tlsClientCertSha256: material.tlsClientCertSha256,
      attestationRefresh: { useSevSnp: false },
      provider: createMockProvider(),
    });

    expect(pool.sessionIds).toHaveLength(4);
    expect(maxInFlight).toBeGreaterThan(1);
    await pool.close();
    delete process.env.TEECHAT_ENGINE_POOL_CONNECT_CONCURRENCY;
    delete process.env.TEECHAT_ENGINE_POOL_CONNECT_STAGGER_MS;
  });

  it("drains idle sessions for half cutover", async () => {
    const poolClient = await import("../src/engine-plane/pool-client.js");
    const pool = await createTestPool({ poolTargetSize: 2, poolInitialFraction: 1 });

    const result = await pool.drainIdlePool(0.5);
    expect(result.drained).toBe(1);
    expect(result.remaining).toBe(1);
    expect(result.blocked).toBe(false);
    expect(pool.sessionIds).toHaveLength(1);
    expect(poolClient.gracefulDisconnectAttestedSession).toHaveBeenCalled();

    await pool.close();
  });

  it("does not drain busy sessions", async () => {
    const pool = await createTestPool({
      poolTargetSize: 2,
      poolInitialFraction: 1,
      busySessions: 2,
    });

    const result = await pool.drainIdlePool(0.5);
    expect(result.drained).toBe(0);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("insufficient_idle_sessions");
    expect(pool.sessionIds).toHaveLength(2);

    await pool.close();
  });

  it("drains only idle sessions when one is busy at full drain", async () => {
    const pool = await createTestPool({
      poolTargetSize: 2,
      poolInitialFraction: 1,
      busySessions: 1,
    });

    const result = await pool.drainIdlePool(1);
    expect(result.drained).toBe(1);
    expect(result.remaining).toBe(1);
    expect(result.blocked).toBe(true);
    expect(pool.sessionIds).toHaveLength(1);

    await pool.close();
  });

  it("scales green to full pool", async () => {
    const poolClient = await import("../src/engine-plane/pool-client.js");
    const pool = await createTestPool({ poolTargetSize: 2, poolInitialFraction: 0.5 });

    const result = await pool.scalePool(2);
    expect(result.added).toBe(1);
    expect(result.total).toBe(2);
    expect(result.blocked).toBe(false);
    expect(poolClient.openPooledConnection).toHaveBeenCalledTimes(2);

    await pool.close();
  });

  it("simulates blue half drain then green scale for paired cutover", async () => {
    const blue = await createTestPool({ poolTargetSize: 2, poolInitialFraction: 1 });
    expect(blue.sessionIds).toHaveLength(2);

    const drain = await blue.drainIdlePool(0.5);
    expect(drain.drained).toBe(1);
    expect(blue.sessionIds).toHaveLength(1);
    await blue.close();

    const green = await createTestPool({ poolTargetSize: 2, poolInitialFraction: 0.5 });
    expect(green.sessionIds).toHaveLength(1);
    const scale = await green.scalePool(2);
    expect(scale.total).toBe(2);
    await green.close();
  });

  it("rejects scale above poolTargetSize", async () => {
    const pool = await createTestPool({ poolTargetSize: 2, poolInitialFraction: 0.5 });
    const result = await pool.scalePool(3);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("invalid_target_size");
    await pool.close();
  });

  it("rejects boot with zero initial sessions", async () => {
    await expect(
      createTestPool({ poolTargetSize: 2, poolInitialFraction: 0 }),
    ).rejects.toThrow(/at least one boot session/);
  });
});
