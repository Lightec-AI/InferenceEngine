/** TeeChat envelope wrapping NVIDIA CC evidence collected via nvattest (v1). */
export interface NvCcGpuEvidenceEnvelopeV1 {
  v: 1;
  kind: "nv-cc";
  collected_at: string;
  /** Hex nonce passed to nvattest collect/attest (optional CPU quote binding). */
  nonce?: string;
  /** Gateway / CPU-only roles — verifier skips when `skipGpuVerification` is set. */
  not_applicable?: boolean;
  /** Dev-only mock marker (never accepted in production builds). */
  source?: "mock" | "nvattest";
  cc_mode?: {
    enabled: boolean;
    dev_tools_attestation?: string;
    environment?: string;
  };
  /** Raw `nvattest collect-evidence --format json` payload. */
  nvattest?: NvattestCollectEvidenceOutput;
  measurements?: {
    driver_version?: string;
    vbios_version?: string;
    architecture?: string;
  };
}

export interface NvattestCollectEvidenceOutput {
  evidences: NvattestGpuEvidenceEntry[];
  result_code: number;
  result_message: string;
}

export interface NvattestGpuEvidenceEntry {
  arch?: string;
  nonce?: string;
  evidence?: string;
  certificate?: string;
  [key: string]: unknown;
}

export interface NvattestAttestOutput {
  claims: Record<string, unknown>[];
  result_code: number;
  result_message: string;
  detached_eat?: unknown;
}

export interface GpuAttestationPolicy {
  requireGpuAttestation: boolean;
  allowedGpuDriverVersions: ReadonlySet<string>;
  allowedGpuVbiosVersions: ReadonlySet<string>;
  allowedGpuArchitectures: ReadonlySet<string>;
  maxGpuEvidenceAgeMs: number;
}

export const DEFAULT_GPU_ATTESTATION_POLICY: GpuAttestationPolicy = {
  requireGpuAttestation: true,
  allowedGpuDriverVersions: new Set(),
  allowedGpuVbiosVersions: new Set(),
  allowedGpuArchitectures: new Set(),
  maxGpuEvidenceAgeMs: 24 * 60 * 60 * 1000,
};

export interface GpuEvidenceVerifyResult {
  ok: boolean;
  reason?: string;
}
