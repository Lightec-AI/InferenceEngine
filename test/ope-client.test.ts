import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_TEST_ATTESTATION_POLICY } from "../src/attestation.js";
import { OpeClient } from "../src/client/ope-client.js";
import { createRealProvider } from "../src/crypto/provider.js";
import { createEngineEpoch, disposeEngineEpoch, type EngineEpoch } from "../src/engine/epoch.js";
import type { EngineTrustBundle, OpeEnvelope } from "../src/protocol/types.js";
import { generateMockEngineKeys } from "../src/testing/index.js";

/**
 * Minimal real engine + gateway: serves the trust bundle and, on chat, decrypts the
 * request, streams an encrypted response, and returns the server share + chunks.
 */
function startEngineGateway(epoch: EngineEpoch, trust: EngineTrustBundle, responseText: string) {
  const provider = createRealProvider();
  const chunks = responseText.match(/.{1,8}/g) ?? [responseText];

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/trust")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(trust));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/ope/chat/completions") {
      const buf: Buffer[] = [];
      req.on("data", (c) => buf.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        const envelope = JSON.parse(Buffer.concat(buf).toString("utf8")) as OpeEnvelope;
        const payload = provider.decryptRequest(epoch.handle!, envelope) as {
          messages: Array<{ content: string }>;
        };
        const { session, serverShare } = provider.beginResponse(epoch.handle!, envelope);
        const encChunks = chunks.map((c, i) =>
          provider.encryptResponseChunk(session, i, Buffer.from(c, "utf8")),
        );
        provider.freeResponse(session);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            echo_prompt: payload.messages[0]?.content,
            server_share: serverShare,
            chunks: encChunks,
          }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise<{ server: http.Server; baseUrl: string }>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no addr"));
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("OpeClient end-to-end (#3)", () => {
  let server: http.Server | undefined;
  let epoch: EngineEpoch | undefined;
  afterEach(async () => {
    if (epoch) disposeEngineEpoch(epoch);
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  it("fetches+verifies trust, encrypts a request, and decrypts the response stream", async () => {
    const material = generateMockEngineKeys({
      engineId: "engine-client",
      models: ["llama3"],
      tlsClientCertSha256: "client-e2e-cert",
    });
    epoch = createEngineEpoch({
      engineId: "engine-client",
      ed25519PublicB64: material.ed25519Public,
      ed25519PrivateKey: material.ed25519PrivateKey,
      attestation: material.registerRequest.attestation,
      provider: createRealProvider(),
    });

    const trust: EngineTrustBundle = {
      engine_id: "engine-client",
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

    const responseText = "Confidential streamed answer from the engine.";
    const started = await startEngineGateway(epoch, trust, responseText);
    server = started.server;

    const client = new OpeClient({
      gatewayBaseUrl: started.baseUrl,
      tlsClientCertSha256: material.tlsClientCertSha256,
      attestationPolicy: DEFAULT_TEST_ATTESTATION_POLICY,
      provider: createRealProvider(),
    });

    const engine = await client.fetchAndVerifyTrust("engine-client");
    expect(engine.identity.mlkem_encapsulation_key).toBe(epoch.hybrid.mlkem_encapsulation_key);

    const prompt = "What is the capital of confidentiality?";
    const { envelope, session } = client.encryptRequest(engine, {
      model: "llama3@teechat",
      messages: [{ role: "user", content: prompt }],
    });
    expect(envelope.enc).toBe("e2e-hybrid-pq");

    const res = await fetch(`${started.baseUrl}/v1/ope/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/ope+json" },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { echo_prompt: string; server_share: string; chunks: string[] };
    expect(body.echo_prompt).toBe(prompt);

    const decoded = body.chunks
      .map((ct, i) => OpeClient.decryptResponseChunk(session, body.server_share, i, ct))
      .map((b) => b.toString("utf8"))
      .join("");
    expect(decoded).toBe(responseText);

    OpeClient.disposeSession(session);
  });

  it("rejects a trust bundle that fails verification", async () => {
    const material = generateMockEngineKeys({
      engineId: "engine-bad-trust",
      models: ["llama3"],
      tlsClientCertSha256: "cert-a",
    });
    epoch = createEngineEpoch({
      engineId: "engine-bad-trust",
      ed25519PublicB64: material.ed25519Public,
      ed25519PrivateKey: material.ed25519PrivateKey,
      attestation: material.registerRequest.attestation,
      provider: createRealProvider(),
    });
    const trust: EngineTrustBundle = {
      engine_id: "engine-bad-trust",
      epoch_id: epoch.epochId,
      not_before: epoch.notBefore,
      not_after: epoch.notAfter,
      hybrid: epoch.hybrid,
      identity: {
        ed25519_public: material.ed25519Public,
        identity_signature: epoch.ephemeralRequest.identity_signature,
      },
      attestation: {
        ...material.registerRequest.attestation,
        engine: {
          ...material.registerRequest.attestation.engine,
          binary_sha256: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        },
      },
      gateway_cached_at: new Date().toISOString(),
    };
    const started = await startEngineGateway(epoch, trust, "unused");
    server = started.server;

    const client = new OpeClient({
      gatewayBaseUrl: started.baseUrl,
      tlsClientCertSha256: material.tlsClientCertSha256,
      attestationPolicy: DEFAULT_TEST_ATTESTATION_POLICY,
      provider: createRealProvider(),
    });
    await expect(client.fetchAndVerifyTrust("engine-bad-trust")).rejects.toThrow(/trust verification/);
  });
});
