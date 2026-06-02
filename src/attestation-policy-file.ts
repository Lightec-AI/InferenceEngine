import { readFileSync } from "node:fs";

import type { AttestationPolicy } from "./attestation.js";

/** JSON on-disk shape for ops-managed allowlists (pre-rent / production). */
export interface AttestationPolicyFileJson {
  policyId: string;
  allowedEngineBinarySha256: string[];
  allowedVllmBinarySha256: string[];
  maxQuoteAgeMs: number;
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error(`attestation_policy_invalid:${field}`);
  }
  return value.map((s) => (s as string).trim().toLowerCase());
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
  };
}

export function loadAttestationPolicyFromFile(filePath: string): AttestationPolicy {
  const text = readFileSync(filePath, "utf8");
  return parseAttestationPolicyJson(text);
}
