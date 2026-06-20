import { execFileSync } from "node:child_process";

import { mockAllowed } from "../build-mode.js";
import {
  buildGpuNotApplicableEvidence,
  buildMockNvCcGpuEvidenceEnvelope,
  encodeLegacyMockGpuEvidence,
  encodeNvCcGpuEvidenceEnvelope,
} from "./encode.js";
import { nvattestBinFromEnv, appendNvattestAttestArgs } from "./rim-service.js";
import type { NvattestCollectEvidenceOutput, NvCcGpuEvidenceEnvelopeV1 } from "./types.js";

export interface CollectNvCcGpuEvidenceArgs {
  env?: NodeJS.ProcessEnv;
  /** Hex nonce for nvattest (bind to CPU REPORT_DATA when provided). */
  nonce?: string;
}

function nvidiaSmiBinFromEnv(env: NodeJS.ProcessEnv): string {
  return (env.TEECHAT_NVIDIA_SMI_BIN ?? "nvidia-smi").trim() || "nvidia-smi";
}

function readConfComputeState(env: NodeJS.ProcessEnv): NvCcGpuEvidenceEnvelopeV1["cc_mode"] {
  const bin = nvidiaSmiBinFromEnv(env);
  try {
    const out = execFileSync(bin, ["conf-compute", "-q"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const enabled = /CC State\s*:\s*ON/i.test(out) || /CC Mode\s*:\s*ON/i.test(out);
    const devTools = out.match(/DevTools\s+Attestation\s*:\s*(\S+)/i)?.[1];
    const environment = out.match(/Environment\s*:\s*(\S+)/i)?.[1];
    return {
      enabled,
      dev_tools_attestation: devTools,
      environment,
    };
  } catch {
    return { enabled: false };
  }
}

function hasCcCapableGpu(env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync(nvidiaSmiBinFromEnv(env), ["-L"], { stdio: ["ignore", "pipe", "pipe"] });
    const cc = readConfComputeState(env);
    return cc?.enabled === true;
  } catch {
    return false;
  }
}

function shouldUseRealGpuCollector(env: NodeJS.ProcessEnv): boolean {
  if ((env.TEECHAT_FORCE_REAL_GPU_ATTESTATION ?? "").trim() === "1") return true;
  if ((env.TEECHAT_GPU_ATTESTATION ?? "").trim().toLowerCase() === "real") return true;
  return !mockAllowed(env);
}

function collectViaNvattest(args: CollectNvCcGpuEvidenceArgs): NvattestCollectEvidenceOutput {
  const env = args.env ?? process.env;
  const bin = nvattestBinFromEnv(env);
  const cliArgs = ["collect-evidence", "--device", "gpu", "--format", "json"];
  if (args.nonce?.trim()) {
    cliArgs.push("--nonce", args.nonce.trim());
  }
  const out = execFileSync(bin, cliArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    timeout: 120_000,
  });
  const parsed = JSON.parse(out) as NvattestCollectEvidenceOutput;
  if (parsed.result_code !== 0 || !Array.isArray(parsed.evidences) || parsed.evidences.length === 0) {
    throw new Error(
      `nvattest_collect_failed:${parsed.result_message ?? parsed.result_code ?? "unknown"}`,
    );
  }
  return parsed;
}

function extractMeasurements(
  collect: NvattestCollectEvidenceOutput,
): NvCcGpuEvidenceEnvelopeV1["measurements"] {
  const first = collect.evidences[0];
  return {
    architecture: typeof first?.arch === "string" ? first.arch : undefined,
  };
}

/** Collect NVIDIA CC GPU evidence on engine guests (nvattest + conf-compute sanity). */
export function collectNvCcGpuEvidence(args: CollectNvCcGpuEvidenceArgs = {}): NvCcGpuEvidenceEnvelopeV1 {
  const env = args.env ?? process.env;
  const ccMode = readConfComputeState(env);

  if (!shouldUseRealGpuCollector(env) || !hasCcCapableGpu(env)) {
    return buildMockNvCcGpuEvidenceEnvelope();
  }

  if (!ccMode?.enabled) {
    throw new Error("gpu_cc_mode_off");
  }

  const nvattest = collectViaNvattest(args);
  return {
    v: 1,
    kind: "nv-cc",
    collected_at: new Date().toISOString(),
    nonce: args.nonce?.trim() || undefined,
    source: "nvattest",
    cc_mode: ccMode,
    nvattest,
    measurements: extractMeasurements(nvattest),
  };
}

/** Base64url evidence string for AttestationBundle.gpu_tee.evidence. */
export function collectNvCcGpuEvidenceB64(args: CollectNvCcGpuEvidenceArgs = {}): string {
  const env = args.env ?? process.env;
  if (!shouldUseRealGpuCollector(env) || !hasCcCapableGpu(env)) {
    if (mockAllowed(env)) return encodeLegacyMockGpuEvidence();
    return buildGpuNotApplicableEvidence();
  }
  return encodeNvCcGpuEvidenceEnvelope(collectNvCcGpuEvidence(args));
}
