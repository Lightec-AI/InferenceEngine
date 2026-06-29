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

describe("supervised pool gateway migration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("migrates idle sessions make-before-break", async () => {
    const material = generateMockEngineKeys({
      engineId: "eng-migrate",
      models: ["m@teechat"],
    });
    const provider = createMockProvider();
    const poolClient = await import("../src/engine-plane/pool-client.js");
    const connectUrls: string[] = [];
    let connectCount = 0;

    vi.spyOn(poolClient, "openPooledConnection").mockImplementation(async (opts) => {
      connectCount += 1;
      connectUrls.push(opts.gatewayBaseUrl);
      return fakeSession();
    });
    vi.spyOn(poolClient, "postEphemeralOnAttestedSession").mockResolvedValue({
      status: 201,
      json: {},
    });
    vi.spyOn(poolClient, "gracefulDisconnectAttestedSession").mockResolvedValue(undefined);
    vi.spyOn(poolClient, "startPullWorker").mockReturnValue({
      stop: () => undefined,
      isBusy: () => false,
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
      ed25519PublicB64: material.ed25519Public,
      ed25519PrivateKey: material.ed25519PrivateKey,
      attestation: material.registerRequest.attestation,
      tlsClientCertSha256: material.tlsClientCertSha256,
      attestationRefresh: { useSevSnp: false },
      provider,
    });

    expect(connectCount).toBe(2);
    expect(connectUrls.every((u) => u === "https://127.0.0.1:8788")).toBe(true);

    const result = await pool.migrateGatewayPool("https://127.0.0.1:8790", 0.5);
    expect(result.moved).toBe(1);
    expect(result.onTarget).toBe(1);
    expect(result.onSource).toBe(1);
    expect(connectUrls).toContain("https://127.0.0.1:8790");
    expect(poolClient.gracefulDisconnectAttestedSession).toHaveBeenCalled();

    await pool.close();
  });
});
