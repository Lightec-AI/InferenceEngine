import { readFileSync } from "node:fs";

import type { AttestationPolicy } from "./attestation.js";
import { DEFAULT_GPU_ATTESTATION_POLICY } from "./nv-cc/types.js";
import {
  parseGoldenAttestationPolicyFromJson,
  type GoldenAttestationPolicyFileJson,
} from "./golden-policy.js";

/** JSON on-disk shape for ops-managed allowlists (pre-rent / production). */
export interface AttestationPolicyFileJson extends GoldenAttestationPolicyFileJson {
  policyId: string;
  allowedEngineBinarySha256: string[];
  allowedVllmBinarySha256: string[];
  maxQuoteAgeMs: number;
  requireGpuAttestation?: boolean;
  allowedGpuDriverVersions?: string[];
  allowedGpuVbiosVersions?: string[];
  allowedGpuArchitectures?: string[];
  maxGpuEvidenceAgeMs?: number;
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error(`attestation_policy_invalid:${field}`);
  }
  return value.map((s) => (s as string).trim().toLowerCase());
}

function assertOptionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  return assertStringArray(value, field);
}

function parseGpuPolicy(rec: AttestationPolicyFileJson): AttestationPolicy["gpu"] {
  const maxGpuEvidenceAgeMs = Number(rec.maxGpuEvidenceAgeMs ?? DEFAULT_GPU_ATTESTATION_POLICY.maxGpuEvidenceAgeMs);
  if (!Number.isFinite(maxGpuEvidenceAgeMs) || maxGpuEvidenceAgeMs <= 0) {
    throw new Error("attestation_policy_invalid:maxGpuEvidenceAgeMs");
  }
  return {
    requireGpuAttestation: rec.requireGpuAttestation ?? DEFAULT_GPU_ATTESTATION_POLICY.requireGpuAttestation,
    allowedGpuDriverVersions: new Set(assertOptionalStringArray(rec.allowedGpuDriverVersions, "allowedGpuDriverVersions")),
    allowedGpuVbiosVersions: new Set(assertOptionalStringArray(rec.allowedGpuVbiosVersions, "allowedGpuVbiosVersions")),
    allowedGpuArchitectures: new Set(assertOptionalStringArray(rec.allowedGpuArchitectures, "allowedGpuArchitectures")),
    maxGpuEvidenceAgeMs: Math.floor(maxGpuEvidenceAgeMs),
  };
}

/** Parse policy JSON (object or stringified file contents). */
export function parseAttestationPolicyJson(raw: unknown): AttestationPolicy {
  const o = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!o || typeof o !== "object") {
    throw new Error("attestation_policy_invalid:expected_object");
  }
  const rec = o as AttestationPolicyFileJson;
  if (typeof rec.policyId !== "string" || !rec.policyId.trim()) {
    throw new Error("attestation_policy_invalid:policyId");
  }
  const maxQuoteAgeMs = Number(rec.maxQuoteAgeMs);
  if (!Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0) {
    throw new Error("attestation_policy_invalid:maxQuoteAgeMs");
  }
  return {
    policyId: rec.policyId.trim(),
    allowedEngineBinarySha256: new Set(assertStringArray(rec.allowedEngineBinarySha256, "engine")),
    allowedVllmBinarySha256: new Set(assertStringArray(rec.allowedVllmBinarySha256, "vllm")),
    maxQuoteAgeMs: Math.floor(maxQuoteAgeMs),
    gpu: parseGpuPolicy(rec),
    golden: parseGoldenAttestationPolicyFromJson(rec),
  };
}

export function loadAttestationPolicyFromFile(filePath: string): AttestationPolicy {
  const text = readFileSync(filePath, "utf8");
  return parseAttestationPolicyJson(text);
}
