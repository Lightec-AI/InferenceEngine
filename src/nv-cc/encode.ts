import { bytesToBase64Url, base64UrlToBytes } from "../crypto-util.js";
import type { NvCcGpuEvidenceEnvelopeV1 } from "./types.js";

export const LEGACY_MOCK_GPU_EVIDENCE_UTF8 = "mock-gpu-tee-evidence";
export const LEGACY_PENDING_GPU_EVIDENCE_UTF8 = "gpu-tee-pending";

export function encodeNvCcGpuEvidenceEnvelope(envelope: NvCcGpuEvidenceEnvelopeV1): string {
  return bytesToBase64Url(Buffer.from(JSON.stringify(envelope), "utf8"));
}

export function decodeNvCcGpuEvidenceEnvelope(evidenceB64: string): NvCcGpuEvidenceEnvelopeV1 | null {
  try {
    const raw = base64UrlToBytes(evidenceB64);
    const text = raw.toString("utf8");
    if (text === LEGACY_MOCK_GPU_EVIDENCE_UTF8 || text === LEGACY_PENDING_GPU_EVIDENCE_UTF8) {
      return null;
    }
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as Partial<NvCcGpuEvidenceEnvelopeV1>;
    if (rec.v !== 1 || rec.kind !== "nv-cc") return null;
    if (typeof rec.collected_at !== "string" || !rec.collected_at.trim()) return null;
    return rec as NvCcGpuEvidenceEnvelopeV1;
  } catch {
    return null;
  }
}

export function isLegacyMockGpuEvidence(evidenceB64: string): boolean {
  try {
    const raw = base64UrlToBytes(evidenceB64);
    const text = raw.toString("utf8");
    return text === LEGACY_MOCK_GPU_EVIDENCE_UTF8 || text === LEGACY_PENDING_GPU_EVIDENCE_UTF8;
  } catch {
    return false;
  }
}

export function buildGpuNotApplicableEvidence(): string {
  const envelope: NvCcGpuEvidenceEnvelopeV1 = {
    v: 1,
    kind: "nv-cc",
    collected_at: new Date().toISOString(),
    not_applicable: true,
  };
  return encodeNvCcGpuEvidenceEnvelope(envelope);
}

export function buildMockNvCcGpuEvidenceEnvelope(): NvCcGpuEvidenceEnvelopeV1 {
  return {
    v: 1,
    kind: "nv-cc",
    collected_at: new Date().toISOString(),
    source: "mock",
    cc_mode: { enabled: true, dev_tools_attestation: "mock", environment: "dev" },
  };
}

export function encodeLegacyMockGpuEvidence(): string {
  return bytesToBase64Url(Buffer.from(LEGACY_MOCK_GPU_EVIDENCE_UTF8, "utf8"));
}
