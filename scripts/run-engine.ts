/**
 * InferenceEngine process entrypoint: supervised OPE pool → gateway + local vLLM/Ollama.
 *
 * Prereqs:
 *   - Gateway on TEECHAT_ENGINE_GATEWAY_URL
 *   - libope_ffi available (TEECHAT_OPE_FFI_LIB or build:ffi)
 *   - OpenAI-compatible upstream (Ollama/vLLM)
 *
 * Env: see TeaChat docs/ops/engine-release.md
 */
import { loadEngineEnvFiles } from "../src/runtime/load-env.js";

loadEngineEnvFiles();

import {
  configureEventLogFromEnv,
  createRealProvider,
  createSupervisedEnginePlanePool,
  installGatewayMigrationControl,
  installEnginePoolDrainControl,
  installEnginePoolScaleControl,
  installEnginePoolStatusControl,
  engineInstanceIdFromEnv,
  loadOpeFfi,
  logEngineShutdown,
  pickUpstreamModel,
  poolInitialFractionFromEnv,
  resolveOpenAiCompatibleUpstream,
  signUsageReport,
  taskModelIdFromEnv,
  vllmTaskConfigFromEnv,
  type UsageReport,
} from "../src/index.js";
import {
  buildAttestedConnectRequest,
  generateMockEngineKeys,
} from "../src/testing/index.js";
import {
  buildSevSnpAttestedConnectRequest,
  generateSevSnpEngineKeys,
  shouldUseSevSnpAttestation,
} from "../src/index.js";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnginePlaneClientTls } from "../src/runtime/engine-tls.js";
import { engineGatewayPlatformVerifyFromEnv } from "../src/runtime/engine-gateway-platform-verify.js";
import { registerAttestationBackendFromEnv } from "../src/runtime/register-attestation-backend.js";

const here = dirname(fileURLToPath(import.meta.url));
const ffiScript = resolve(here, "build-ope-ffi.mjs");

function ensureFfi(): void {
  if (loadOpeFfi()) return;
  const libPath = process.env.TEECHAT_OPE_FFI_LIB?.trim();
  if (libPath && existsSync(libPath)) {
    throw new Error(`failed to load ope ffi from TEECHAT_OPE_FFI_LIB=${libPath}`);
  }
  if (!existsSync(ffiScript)) throw new Error(`missing ${ffiScript}`);
  execFileSync(process.execPath, [ffiScript], { stdio: "inherit" });
  if (!loadOpeFfi()) throw new Error("ope-ffi failed to load after build");
}

async function main(): Promise<void> {
  configureEventLogFromEnv(process.env);
  ensureFfi();

  const upstream = await resolveOpenAiCompatibleUpstream();
  if (!upstream?.baseUrl) {
    throw new Error(
      "No OpenAI-compatible upstream found. Start Ollama (`ollama serve`) and pull a model, or set VLLM_BASE_URL.",
    );
  }
  const model = upstream?.models.length
    ? pickUpstreamModel(upstream)
    : pickUpstreamModel({
        baseUrl: upstream!.baseUrl,
        models: [process.env.OLLAMA_MODEL?.trim() || "unknown"],
      });
  process.env.VLLM_BASE_URL = upstream!.baseUrl;
  const registryModels = upstream!.models.length
    ? upstream!.models.map((name) => (name.includes("@") ? name : `${name}@teechat`))
    : [`${model.includes("@") ? model : `${model}@teechat`}`];

  const taskVllm = vllmTaskConfigFromEnv(process.env);
  const taskModelId = taskModelIdFromEnv(process.env);
  if (taskVllm && taskModelId) {
    const taskTag = taskModelId.includes("@") ? taskModelId : `${taskModelId}@teechat`;
    if (!registryModels.some((m) => m === taskTag || m.startsWith(`${taskModelId}@`))) {
      registryModels.push(taskTag);
    }
  }

  const gatewayBase =
    process.env.TEECHAT_ENGINE_GATEWAY_URL?.trim() || "https://127.0.0.1:8788";
  const tls = loadEnginePlaneClientTls();
  const poolTargetSize = Math.max(
    1,
    Number(process.env.TEECHAT_OPE_ENGINE_POOL_TARGET_SIZE ?? "1") || 1,
  );
  const provider = createRealProvider();
  const engineId = process.env.TEECHAT_OPE_ENGINE_ID?.trim() || "engine-ollama-dev";

  const useSevSnp = shouldUseSevSnpAttestation(process.env);
  const material = useSevSnp
    ? generateSevSnpEngineKeys({
        engineId,
        models: registryModels,
        tlsClientCertSha256: tls.clientCertSha256,
        root: process.cwd(),
      })
    : generateMockEngineKeys({
        engineId,
        models: registryModels,
        tlsClientCertSha256: tls.clientCertSha256,
      });

  const buildConnect = useSevSnp ? buildSevSnpAttestedConnectRequest : buildAttestedConnectRequest;
  const instanceId = engineInstanceIdFromEnv(process.env);

  const gatewayPlatformVerify = engineGatewayPlatformVerifyFromEnv(process.env);
  if (gatewayPlatformVerify) {
    registerAttestationBackendFromEnv(process.env);
  }

  const pool = await createSupervisedEnginePlanePool({
    gatewayBaseUrl: gatewayBase,
    tls,
    connect: buildConnect({
      material,
      sessionId: randomUUID(),
      poolTargetSize,
      instanceId,
    }),
    poolTargetSize,
    poolInitialFraction: poolInitialFractionFromEnv(process.env),
    gatewayPlatformVerify,
    ed25519PublicB64: material.ed25519Public,
    ed25519PrivateKey: material.ed25519PrivateKey,
    attestation: material.registerRequest.attestation,
    tlsClientCertSha256: material.tlsClientCertSha256,
    attestationRefresh: useSevSnp ? { useSevSnp: true, root: process.cwd() } : { useSevSnp: false },
    provider,
    inference: {
      decryptor: undefined,
      vllm: { baseUrl: upstream!.baseUrl },
      ...(taskVllm && taskModelId
        ? { taskVllm: { baseUrl: taskVllm.baseUrl, modelId: taskModelId, apiKey: taskVllm.apiKey } }
        : {}),
      onInference: (envelope, prefillTokens, completionTokens = 1) => {
        const report: UsageReport = {
          request_id: randomUUID(),
          conversation_id: envelope.meta?.conversation_id ?? "conv",
          engine_id: envelope.engine_id ?? engineId,
          prompt_tokens: prefillTokens,
          completion_tokens: completionTokens,
          ts: new Date().toISOString(),
        };
        return { report, sig: signUsageReport(material.ed25519PrivateKey, report) };
      },
    },
  });

  installGatewayMigrationControl({
    pool,
    engineId,
    requestFile: process.env.TEECHAT_ENGINE_GATEWAY_MIGRATION_FILE?.trim(),
  });

  installEnginePoolDrainControl({
    pool,
    engineId,
    requestFile: process.env.TEECHAT_ENGINE_POOL_DRAIN_FILE?.trim(),
  });

  installEnginePoolScaleControl({
    pool,
    engineId,
    requestFile: process.env.TEECHAT_ENGINE_POOL_SCALE_FILE?.trim(),
  });

  installEnginePoolStatusControl({
    pool,
    engineId,
    statusFile: process.env.TEECHAT_ENGINE_POOL_STATUS_FILE?.trim(),
  });

  // eslint-disable-next-line no-console
  console.log(
    `[inference-engine] engine_id=${engineId} attestation=${useSevSnp ? "sev-snp" : "mock"} primary=${model} models=${registryModels.join(",")} upstream=${upstream.baseUrl} gateway=${gatewayBase}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[inference-engine] supervised pool running (epoch=${pool.currentEpoch().epochId}) — Ctrl+C to stop`,
  );

  const shutdown = async (): Promise<void> => {
    logEngineShutdown(engineId, process.env.TEECHAT_BUILD_ID);
    await pool.close("shutdown");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise(() => {
    /* keep alive */
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
