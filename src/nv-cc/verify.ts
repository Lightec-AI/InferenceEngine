import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeNvCcGpuEvidenceEnvelope,
  isLegacyMockGpuEvidence,
} from "./encode.js";
import { appendNvattestAttestArgs, nvattestBinFromEnv } from "./rim-service.js";
import type {
  GpuAttestationPolicy,
  GpuEvidenceVerifyResult,
  NvattestAttestOutput,
  NvCcGpuEvidenceEnvelopeV1,
} from "./types.js";

function claimBool(claims: Record<string, unknown>, key: string): boolean {
  return claims[key] === true;
}

function certChainValidated(claims: Record<string, unknown>): boolean {
  if (claimBool(claims, "x-nvidia-gpu-attestation-report-cert-chain-validated")) return true;
  const chain = claims["x-nvidia-gpu-attestation-report-cert-chain"];
  if (!chain || typeof chain !== "object") return false;
  const rec = chain as Record<string, unknown>;
  return rec["x-nvidia-cert-status"] === "valid" && rec["x-nvidia-cert-ocsp-status"] === "good";
}

function rimSchemaValidated(claims: Record<string, unknown>, kind: "driver" | "vbios"): boolean {
  const flatKey =
    kind === "driver"
      ? "x-nvidia-gpu-driver-rim-schema-validated"
      : "x-nvidia-gpu-vbios-rim-schema-validated";
  if (claimBool(claims, flatKey)) return true;
  const sigKey =
    kind === "driver"
      ? "x-nvidia-gpu-driver-rim-signature-verified"
      : "x-nvidia-gpu-vbios-rim-signature-verified";
  const matchKey =
    kind === "driver"
      ? "x-nvidia-gpu-driver-rim-version-match"
      : "x-nvidia-gpu-vbios-rim-version-match";
  return claimBool(claims, sigKey) && claimBool(claims, matchKey);
}

function claimRequiredTrue(claims: Record<string, unknown>, key: string): boolean {
  switch (key) {
    case "x-nvidia-gpu-attestation-report-cert-chain-validated":
      return certChainValidated(claims);
    case "x-nvidia-gpu-driver-rim-schema-validated":
      return rimSchemaValidated(claims, "driver");
    case "x-nvidia-gpu-vbios-rim-schema-validated":
      return rimSchemaValidated(claims, "vbios");
    default:
      return claimBool(claims, key);
  }
}

/** Validate nvattest local-verifier claims against TeaChat GPU policy. */
export function validateNvGpuClaimsAgainstPolicy(
  claims: Record<string, unknown>,
  policy: GpuAttestationPolicy,
): GpuEvidenceVerifyResult {
  const requiredTrue = [
    "x-nvidia-gpu-driver-rim-signature-verified",
    "x-nvidia-gpu-vbios-rim-signature-verified",
    "x-nvidia-gpu-attestation-report-cert-chain-validated",
    "x-nvidia-gpu-attestation-report-signature-verified",
    "x-nvidia-gpu-driver-rim-schema-validated",
    "x-nvidia-gpu-vbios-rim-schema-validated",
    "x-nvidia-gpu-arch-check",
  ] as const;

  for (const key of requiredTrue) {
    if (!claimRequiredTrue(claims, key)) {
      return { ok: false, reason: `gpu_claim_${key}` };
    }
  }

  if (claims.measres !== "success") {
    return { ok: false, reason: "gpu_measres_not_success" };
  }
  if (claims.secboot !== true) {
    return { ok: false, reason: "gpu_secboot_false" };
  }

  const driverVersion = String(claims["x-nvidia-gpu-driver-version"] ?? "").trim().toLowerCase();
  if (policy.allowedGpuDriverVersions.size > 0 && !policy.allowedGpuDriverVersions.has(driverVersion)) {
    return { ok: false, reason: "gpu_driver_version_not_allowed" };
  }

  const vbiosVersion = String(claims["x-nvidia-gpu-vbios-version"] ?? "").trim().toLowerCase();
  if (policy.allowedGpuVbiosVersions.size > 0 && !policy.allowedGpuVbiosVersions.has(vbiosVersion)) {
    return { ok: false, reason: "gpu_vbios_version_not_allowed" };
  }

  if (policy.allowedGpuArchitectures.size > 0) {
    const arch = String(claims["x-nvidia-gpu-architecture"] ?? claims.arch ?? "").trim().toUpperCase();
    const allowed = [...policy.allowedGpuArchitectures].map((a) => a.trim().toUpperCase());
    if (!arch || !allowed.includes(arch)) {
      return { ok: false, reason: "gpu_architecture_not_allowed" };
    }
  }

  return { ok: true };
}

function evidenceAgeOk(envelope: NvCcGpuEvidenceEnvelopeV1, nowMs: number, policy: GpuAttestationPolicy): boolean {
  const collected = Date.parse(envelope.collected_at);
  if (Number.isNaN(collected)) return false;
  return nowMs - collected <= policy.maxGpuEvidenceAgeMs;
}

function runNvattestLocalVerify(
  envelope: NvCcGpuEvidenceEnvelopeV1,
  env: NodeJS.ProcessEnv,
): { ok: true; claims: Record<string, unknown>[] } | { ok: false; reason: string } {
  if (!envelope.nvattest?.evidences?.length) {
    return { ok: false, reason: "gpu_evidence_missing_nvattest" };
  }

  const bin = nvattestBinFromEnv(env);
  const dir = mkdtempSync(join(tmpdir(), "teechat-nvattest-"));
  try {
    const evidenceFile = join(dir, "gpu_evidence.json");
    writeFileSync(evidenceFile, JSON.stringify(envelope.nvattest.evidences), "utf8");

    const args = appendNvattestAttestArgs(
      [
        "attest",
        "--device",
        "gpu",
        "--verifier",
        "local",
        "--gpu-evidence-source",
        "file",
        "--gpu-evidence-file",
        evidenceFile,
        "--format",
        "json",
      ],
      env,
    );
    if (envelope.nonce?.trim()) {
      args.push("--nonce", envelope.nonce.trim());
    }

    const out = execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      timeout: 180_000,
    });
    const parsed = JSON.parse(out) as NvattestAttestOutput;
    if (parsed.result_code !== 0) {
      return {
        ok: false,
        reason: `nvattest_${parsed.result_message ?? parsed.result_code}`,
      };
    }
    if (!Array.isArray(parsed.claims) || parsed.claims.length === 0) {
      return { ok: false, reason: "nvattest_empty_claims" };
    }
    return { ok: true, claims: parsed.claims };
  } catch {
    return { ok: false, reason: "nvattest_verify_failed" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface VerifyNvCcGpuEvidenceOptions {
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  skipGpuVerification?: boolean;
}

/** Verify NVIDIA CC GPU evidence (RIM chain + measurement compare via nvattest local verifier). */
export function verifyNvCcGpuEvidence(
  evidenceB64: string,
  policy: GpuAttestationPolicy,
  opts: VerifyNvCcGpuEvidenceOptions = {},
): GpuEvidenceVerifyResult {
  const env = opts.env ?? process.env;
  const nowMs = opts.nowMs ?? Date.now();

  if (opts.skipGpuVerification) {
    const envelope = decodeNvCcGpuEvidenceEnvelope(evidenceB64);
    if (envelope?.not_applicable) return { ok: true };
    if (isLegacyMockGpuEvidence(evidenceB64)) return { ok: true };
    return { ok: false, reason: "gpu_verification_required" };
  }

  if (!policy.requireGpuAttestation) {
    return { ok: true };
  }

  if (isLegacyMockGpuEvidence(evidenceB64)) {
    return { ok: false, reason: "legacy_gpu_placeholder" };
  }

  const envelope = decodeNvCcGpuEvidenceEnvelope(evidenceB64);
  if (!envelope) {
    return { ok: false, reason: "invalid_gpu_evidence_envelope" };
  }
  if (envelope.not_applicable) {
    return { ok: false, reason: "gpu_not_applicable" };
  }
  if (envelope.source === "mock") {
    return { ok: false, reason: "mock_gpu_evidence" };
  }
  if (!evidenceAgeOk(envelope, nowMs, policy)) {
    return { ok: false, reason: "gpu_evidence_stale" };
  }
  if (!envelope.cc_mode?.enabled) {
    return { ok: false, reason: "gpu_cc_mode_off" };
  }

  const attest = runNvattestLocalVerify(envelope, env);
  if (!attest.ok) return attest;

  for (const rawClaims of attest.claims) {
    const claims: Record<string, unknown> = { ...rawClaims };
    if (!claims["x-nvidia-gpu-architecture"] && !claims.arch && envelope.measurements?.architecture) {
      claims["x-nvidia-gpu-architecture"] = envelope.measurements.architecture;
    }
    const verdict = validateNvGpuClaimsAgainstPolicy(claims, policy);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/** Dev/staging fixture verifier — accepts legacy mock evidence only. */
export function verifyMockNvCcGpuEvidence(evidenceB64: string): GpuEvidenceVerifyResult {
  if (isLegacyMockGpuEvidence(evidenceB64)) return { ok: true };
  const envelope = decodeNvCcGpuEvidenceEnvelope(evidenceB64);
  if (envelope?.source === "mock") return { ok: true };
  return { ok: false, reason: "invalid_mock_gpu_evidence" };
}
