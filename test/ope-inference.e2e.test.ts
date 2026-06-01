import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_TEST_ATTESTATION_POLICY } from "../src/attestation.js";
import { OpeClient } from "../src/client/ope-client.js";
import { createEngineEpoch, createRealProvider, disposeEngineEpoch, loadOpeFfi } from "../src/index.js";
import { runOpeInferenceOnEnvelope } from "../src/server/ope-inference.js";
import { generateMockEngineKeys } from "../src/testing/index.js";

const ffiScript = resolve(import.meta.dirname, "..", "scripts", "build-ope-ffi.mjs");

function canRunNative(): boolean {
  if (!existsSync(ffiScript)) return false;
  try {
    if (loadOpeFfi()) return true;
    execFileSync(process.execPath, [ffiScript], { stdio: "ignore" });
    return loadOpeFfi() != null;
  } catch {
    return false;
  }
}

describe.runIf(canRunNative())("ope-inference E2E with vLLM mock upstream", () => {
  it("decrypts, calls vLLM, encrypts response chunks", async () => {
    const provider = createRealProvider();
    const material = generateMockEngineKeys({
      engineId: "engine-vllm",
      models: ["llama3"],
      tlsClientCertSha256: "cert",
    });
    const epoch = createEngineEpoch({
      engineId: "engine-vllm",
      ed25519PublicB64: material.ed25519Public,
      ed25519PrivateKey: material.ed25519PrivateKey,
      attestation: material.registerRequest.attestation,
      provider,
    });

    const client = new OpeClient({
      gatewayBaseUrl: "http://127.0.0.1:9",
      tlsClientCertSha256: material.tlsClientCertSha256,
      attestationPolicy: DEFAULT_TEST_ATTESTATION_POLICY,
      provider,
    });

    const engine = {
      engineId: "engine-vllm",
      epochId: epoch.epochId,
      identity: {
        engine_id: "engine-vllm",
        kex: epoch.hybrid.kex,
        mlkem_encapsulation_key: epoch.hybrid.mlkem_encapsulation_key,
        x25519_public: epoch.hybrid.x25519_public,
        ed25519_public: material.ed25519Public,
      },
      trust: {} as never,
    };

    const { envelope } = client.encryptRequest(
      engine,
      { model: "llama3@teechat", messages: [{ role: "user", content: "Say hi" }] },
      { kid: "u1", meta: { conversation_id: "conv-vllm", model: "llama3@teechat" } },
    );

    const sse = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n",
      "data: [DONE]\n",
    ].join("");

    const fetchImpl = async () =>
      ({
        ok: true,
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: async () => {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: new TextEncoder().encode(sse) };
              },
            };
          },
        },
      }) as Response;

    const res = await runOpeInferenceOnEnvelope(envelope, {
      decryptor: { handle: epoch.handle!, provider },
      vllm: { baseUrl: "http://127.0.0.1:8000", fetchImpl },
      chunkChars: 8,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { server_share: string; chunks: string[] };
    expect(body.chunks.length).toBeGreaterThan(0);

    disposeEngineEpoch(epoch);
  });
});
