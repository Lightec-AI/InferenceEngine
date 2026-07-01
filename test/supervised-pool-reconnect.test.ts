import type { ClientHttp2Session } from "node:http2";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseMockCpuQuote } from "../src/attestation.js";
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

async function createReconnectTestPool() {
  const material = generateMockEngineKeys({
    engineId: "eng-reconnect",
    models: ["m@teechat"],
  });
  const provider = createMockProvider();
  const poolClient = await import("../src/engine-plane/pool-client.js");
  const connectBodies: Array<{ attestation: { cpu_tee: { quote: string } } }> = [];
  const connectSessionIds: string[] = [];
  let connectCount = 0;

  vi.spyOn(poolClient, "openPooledConnection").mockImplementation(async (opts, sessionId) => {
    connectCount += 1;
    connectSessionIds.push(sessionId);
    connectBodies.push(opts.connect as typeof connectBodies[number]);
    return fakeSession();
  });
  vi.spyOn(poolClient, "postEphemeralOnAttestedSession").mockResolvedValue({
    status: 201,
    json: {},
  });
  const disconnectSpy = vi
    .spyOn(poolClient, "gracefulDisconnectAttestedSession")
    .mockResolvedValue(undefined);
  vi.spyOn(poolClient, "startPullWorker").mockReturnValue({ stop: () => undefined, isBusy: () => false });

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
      poolTargetSize: 1,
    }),
    poolTargetSize: 1,
    ed25519PublicB64: material.ed25519Public,
    ed25519PrivateKey: material.ed25519PrivateKey,
    attestation: material.registerRequest.attestation,
    tlsClientCertSha256: material.tlsClientCertSha256,
    attestationRefresh: { useSevSnp: false },
    provider,
  });

  return {
    pool,
    poolClient,
    connectBodies,
    connectSessionIds,
    get connectCount() {
      return connectCount;
    },
    disconnectSpy,
    bootSessionId: pool.sessionIds[0]!,
  };
}

describe("supervised pool reconnect attestation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("refreshes attestation before reconnect connect", async () => {
    vi.useFakeTimers();
    const ctx = await createReconnectTestPool();

    expect(ctx.connectCount).toBe(1);
    ctx.pool.sessions[0]!.close();

    await vi.advanceTimersByTimeAsync(1_500);

    expect(ctx.connectCount).toBe(2);
    const bootClaims = parseMockCpuQuote(ctx.connectBodies[0]!.attestation.cpu_tee.quote);
    const reconnectClaims = parseMockCpuQuote(ctx.connectBodies[1]!.attestation.cpu_tee.quote);
    expect(reconnectClaims?.issued_at).not.toBe(bootClaims?.issued_at);

    await ctx.pool.close();
  });

  it("keeps session id across reconnect", async () => {
    vi.useFakeTimers();
    const ctx = await createReconnectTestPool();
    const bootId = ctx.bootSessionId;

    ctx.pool.sessions[0]!.close();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(ctx.connectSessionIds).toEqual([bootId, bootId]);
    expect(ctx.pool.sessionIds[0]).toBe(bootId);

    await ctx.pool.close();
  });

  it("calls graceful disconnect with admin reason before reconnect", async () => {
    vi.useFakeTimers();
    const ctx = await createReconnectTestPool();
    const bootId = ctx.bootSessionId;

    ctx.pool.sessions[0]!.close();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(ctx.disconnectSpy).toHaveBeenCalledTimes(1);
    expect(ctx.disconnectSpy).toHaveBeenCalledWith(
      expect.anything(),
      bootId,
      "eng-reconnect",
      "admin",
    );

    await ctx.pool.close();
  });

  it("reconnects with same session id when graceful disconnect fails", async () => {
    vi.useFakeTimers();
    const ctx = await createReconnectTestPool();
    const bootId = ctx.bootSessionId;
    ctx.disconnectSpy.mockRejectedValueOnce(new Error("disconnect rpc failed"));

    ctx.pool.sessions[0]!.close();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(ctx.connectSessionIds).toEqual([bootId, bootId]);
    expect(ctx.pool.sessionIds[0]).toBe(bootId);
    expect(ctx.connectCount).toBe(2);

    await ctx.pool.close();
  });

  it("retries reconnect with same session id after connect failure", async () => {
    vi.useFakeTimers();
    const ctx = await createReconnectTestPool();
    const bootId = ctx.bootSessionId;
    const openSpy = ctx.poolClient.openPooledConnection as ReturnType<typeof vi.spyOn>;

    ctx.pool.sessions[0]!.close();
    openSpy.mockRejectedValueOnce(new Error("tls handshake failed"));
    await vi.advanceTimersByTimeAsync(1_500);

    expect(ctx.pool.sessionIds[0]).toBe(bootId);

    openSpy.mockImplementation(async (_opts, sessionId) => {
      ctx.connectSessionIds.push(sessionId);
      return fakeSession();
    });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(ctx.connectSessionIds.filter((id) => id === bootId).length).toBeGreaterThanOrEqual(2);
    expect(ctx.pool.sessionIds[0]).toBe(bootId);

    await ctx.pool.close();
  });

  it("does not invoke graceful disconnect twice for one reconnect", async () => {
    vi.useFakeTimers();
    const ctx = await createReconnectTestPool();
    let resolveConnect: ((s: ClientHttp2Session) => void) | undefined;
    const openSpy = ctx.poolClient.openPooledConnection as ReturnType<typeof vi.spyOn>;

    openSpy.mockImplementation(
      (_opts, sessionId) =>
        new Promise<ClientHttp2Session>((resolve) => {
          if (ctx.connectSessionIds.length >= 1) {
            resolveConnect = resolve;
            return;
          }
          ctx.connectSessionIds.push(sessionId);
          resolve(fakeSession());
        }),
    );

    ctx.pool.sessions[0]!.close();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(ctx.disconnectSpy).toHaveBeenCalledTimes(1);

    resolveConnect?.(fakeSession());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(ctx.disconnectSpy).toHaveBeenCalledTimes(1);

    await ctx.pool.close();
  });
});
