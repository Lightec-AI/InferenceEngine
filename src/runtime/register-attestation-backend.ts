import {
  clearProductionQuoteBackend,
  isProductionQuoteBackendRegistered,
  registerProductionQuoteBackend,
} from "../attestation.js";
import {
  createFixtureProductionQuoteBackend,
} from "../attestation-fixture-backend.js";
import { createSevSnpProductionQuoteBackend } from "../attestation-sev-snp-backend.js";
import { createNvCcProductionGpuEvidenceBackend } from "../attestation-gpu-backend.js";
import {
  clearProductionGpuEvidenceBackend,
  createFixtureProductionGpuEvidenceBackend,
  isProductionGpuEvidenceBackendRegistered,
  registerProductionGpuEvidenceBackend,
} from "../gpu-attestation.js";

export type AttestationBackendMode = "none" | "fixture" | "external";

export function attestationBackendModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AttestationBackendMode {
  const raw = (env.TEECHAT_ATTESTATION_BACKEND ?? "").trim().toLowerCase();
  if (raw === "fixture" || raw === "canary") return "fixture";
  if (raw === "external" || raw === "production" || raw === "ope-attest") return "external";
  if (raw === "none" || raw === "off" || raw === "mock") return "none";
  return "none";
}

export interface RegisterAttestationBackendResult {
  mode: AttestationBackendMode;
  registered: boolean;
  gpuRegistered: boolean;
}

let lastRegistration: RegisterAttestationBackendResult | null = null;

/** Idempotent registration used at engine/gateway startup and in tests. */
export function registerAttestationBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RegisterAttestationBackendResult {
  const mode = attestationBackendModeFromEnv(env);
  if (mode === "fixture") {
    if (!isProductionQuoteBackendRegistered()) {
      registerProductionQuoteBackend(createFixtureProductionQuoteBackend());
    }
    if (!isProductionGpuEvidenceBackendRegistered()) {
      registerProductionGpuEvidenceBackend(createFixtureProductionGpuEvidenceBackend());
    }
    lastRegistration = {
      mode,
      registered: true,
      gpuRegistered: isProductionGpuEvidenceBackendRegistered(),
    };
    return lastRegistration;
  }
  if (mode === "external") {
    if (!isProductionQuoteBackendRegistered()) {
      registerProductionQuoteBackend(createSevSnpProductionQuoteBackend({ env }));
    }
    if (!isProductionGpuEvidenceBackendRegistered()) {
      registerProductionGpuEvidenceBackend(createNvCcProductionGpuEvidenceBackend({ env }));
    }
    lastRegistration = {
      mode,
      registered: isProductionQuoteBackendRegistered(),
      gpuRegistered: isProductionGpuEvidenceBackendRegistered(),
    };
    return lastRegistration;
  }
  lastRegistration = { mode, registered: false, gpuRegistered: false };
  return lastRegistration;
}

export function resetAttestationBackendRegistration(): void {
  clearProductionQuoteBackend();
  clearProductionGpuEvidenceBackend();
  lastRegistration = null;
}

export function getLastAttestationBackendRegistration(): RegisterAttestationBackendResult | null {
  return lastRegistration;
}
