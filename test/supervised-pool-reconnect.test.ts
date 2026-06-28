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

describe("supervised pool reconnect attestation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("refreshes attestation before reconnect connect", async () => {
    vi.useFakeTimers();

    const material = generateMockEngineKeys({
      engineId: "eng-reconnect",
      models: ["m@teechat"],
    });
    const provider = createMockProvider();
    const poolClient = await import("../src/engine-plane/pool-client.js");
    const connectBodies: Array<{ attestation: { cpu_tee: { quote: string } } }> = [];
    let connectCount = 0;

    vi.spyOn(poolClient, "openPooledConnection").mockImplementation(async (opts) => {
      connectCount += 1;
      connectBodies.push(opts.connect as typeof connectBodies[number]);
      return fakeSession();
    });
    vi.spyOn(poolClient, "postEphemeralOnAttestedSession").mockResolvedValue({
      status: 201,
      json: {},
    });
    vi.spyOn(poolClient, "startPullWorker").mockReturnValue(() => undefined);

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

    expect(connectCount).toBe(1);
    pool.sessions[0]!.close();

    await vi.advanceTimersByTimeAsync(1_500);

    expect(connectCount).toBe(2);
    const bootClaims = parseMockCpuQuote(connectBodies[0]!.attestation.cpu_tee.quote);
    const reconnectClaims = parseMockCpuQuote(connectBodies[1]!.attestation.cpu_tee.quote);
    expect(reconnectClaims?.issued_at).not.toBe(bootClaims?.issued_at);

    await pool.close();
  });
});
