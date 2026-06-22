import { bytesToBase64Url, base64UrlToBytes } from "../base64url.js";
import type { NvCcGpuEvidenceEnvelopeV1 } from "./types.js";

export const LEGACY_MOCK_GPU_EVIDENCE_UTF8 = "mock-gpu-tee-evidence";
export const LEGACY_PENDING_GPU_EVIDENCE_UTF8 = "gpu-tee-pending";

/** Decode base64url to UTF-8 in browser/Tauri webviews where Node `Buffer` is unavailable. */
function base64UrlToUtf8(s: string): string {
  if (typeof Buffer !== "undefined") {
    return base64UrlToBytes(s).toString("utf8");
  }
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const rem = b64.length % 4;
  if (rem) b64 += "=".repeat(4 - rem);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeNvCcGpuEvidenceEnvelope(envelope: NvCcGpuEvidenceEnvelopeV1): string {
  return bytesToBase64Url(Buffer.from(JSON.stringify(envelope), "utf8"));
}

export function decodeNvCcGpuEvidenceEnvelope(evidenceB64: string): NvCcGpuEvidenceEnvelopeV1 | null {
  try {
    const text = base64UrlToUtf8(evidenceB64);
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
    const text = base64UrlToUtf8(evidenceB64);
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
