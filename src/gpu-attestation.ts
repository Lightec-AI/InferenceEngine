import type { GpuAttestationPolicy, GpuEvidenceVerifyResult } from "./nv-cc/types.js";
import { decodeNvCcGpuEvidenceEnvelope, isLegacyMockGpuEvidence } from "./nv-cc/encode.js";
import {
  verifyMockNvCcGpuEvidence,
  verifyNvCcGpuEvidence,
  type VerifyNvCcGpuEvidenceOptions,
} from "./nv-cc/verify.js";
import { mockAllowed } from "./build-mode.js";

export type { GpuAttestationPolicy, GpuEvidenceVerifyResult };

export interface GpuEvidenceVerifyOptions extends VerifyNvCcGpuEvidenceOptions {}

/** Validates NVIDIA CC GPU evidence blobs attached to attestation bundles. */
export interface GpuEvidenceVerifier {
  readonly kind: "mock" | "production";
  verify(
    evidenceB64: string,
    policy: GpuAttestationPolicy,
    nowMs: number,
    opts?: GpuEvidenceVerifyOptions,
  ): GpuEvidenceVerifyResult;
}

export class MockGpuEvidenceVerifier implements GpuEvidenceVerifier {
  readonly kind = "mock" as const;
  verify(
    evidenceB64: string,
    _policy: GpuAttestationPolicy,
    _nowMs: number,
    opts: GpuEvidenceVerifyOptions = {},
  ): GpuEvidenceVerifyResult {
    if (opts.skipGpuVerification) {
      const envelope = decodeNvCcGpuEvidenceEnvelope(evidenceB64);
      if (envelope?.not_applicable) return { ok: true };
      if (isLegacyMockGpuEvidence(evidenceB64)) return { ok: true };
      return { ok: false, reason: "gpu_verification_required" };
    }
    return verifyMockNvCcGpuEvidence(evidenceB64);
  }
}

export type ProductionGpuEvidenceBackend = (
  evidenceB64: string,
  policy: GpuAttestationPolicy,
  nowMs: number,
  opts?: GpuEvidenceVerifyOptions,
) => GpuEvidenceVerifyResult;

let productionGpuBackend: ProductionGpuEvidenceBackend | null = null;

export function registerProductionGpuEvidenceBackend(backend: ProductionGpuEvidenceBackend): void {
  productionGpuBackend = backend;
}

export function clearProductionGpuEvidenceBackend(): void {
  productionGpuBackend = null;
}

export function isProductionGpuEvidenceBackendRegistered(): boolean {
  return productionGpuBackend !== null;
}

export class ProductionGpuEvidenceVerifier implements GpuEvidenceVerifier {
  readonly kind = "production" as const;
  constructor(
    private readonly backend: ProductionGpuEvidenceBackend | null = productionGpuBackend,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
  verify(
    evidenceB64: string,
    policy: GpuAttestationPolicy,
    nowMs: number,
    opts: GpuEvidenceVerifyOptions = {},
  ): GpuEvidenceVerifyResult {
    if (opts.skipGpuVerification) {
      return verifyNvCcGpuEvidence(evidenceB64, policy, {
        ...opts,
        env: this.env,
        nowMs,
        skipGpuVerification: true,
      });
    }
    if (!this.backend) {
      throw new Error(
        "production GPU attestation backend not configured; call registerProductionGpuEvidenceBackend()",
      );
    }
    return this.backend(evidenceB64, policy, nowMs, { ...opts, env: this.env });
  }
}

export function resolveGpuEvidenceVerifier(env: NodeJS.ProcessEnv = process.env): GpuEvidenceVerifier {
  return mockAllowed(env) ? new MockGpuEvidenceVerifier() : new ProductionGpuEvidenceVerifier(undefined, env);
}

export function createFixtureProductionGpuEvidenceBackend(): ProductionGpuEvidenceBackend {
  return (evidenceB64, _policy, _nowMs, opts) => {
    if (opts?.skipGpuVerification) return { ok: true };
    return verifyMockNvCcGpuEvidence(evidenceB64);
  };
}
