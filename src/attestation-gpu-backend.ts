import type { ProductionGpuEvidenceBackend } from "./gpu-attestation.js";
import { verifyNvCcGpuEvidence } from "./nv-cc/verify.js";

export interface NvCcGpuBackendOptions {
  env?: NodeJS.ProcessEnv;
}

/** Production GPU evidence backend: nvattest local verifier + NVIDIA RIM chain. */
export function createNvCcProductionGpuEvidenceBackend(
  opts: NvCcGpuBackendOptions = {},
): ProductionGpuEvidenceBackend {
  const env = opts.env ?? process.env;
  return (evidenceB64, policy, nowMs, verifyOpts) =>
    verifyNvCcGpuEvidence(evidenceB64, policy, { ...verifyOpts, env, nowMs });
}
