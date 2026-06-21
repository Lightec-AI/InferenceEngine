import { describe, expect, it } from "vitest";

import {
  DEFAULT_GPU_ATTESTATION_POLICY,
  validateNvGpuClaimsAgainstPolicy,
  verifyMockNvCcGpuEvidence,
  verifyNvCcGpuEvidence,
  buildGpuNotApplicableEvidence,
  encodeLegacyMockGpuEvidence,
} from "../src/nv-cc/index.js";

function passingGpuClaims(): Record<string, unknown> {
  return {
    "x-nvidia-gpu-driver-rim-signature-verified": true,
    "x-nvidia-gpu-vbios-rim-signature-verified": true,
    "x-nvidia-gpu-attestation-report-cert-chain-validated": true,
    "x-nvidia-gpu-attestation-report-signature-verified": true,
    "x-nvidia-gpu-driver-rim-schema-validated": true,
    "x-nvidia-gpu-vbios-rim-schema-validated": true,
    "x-nvidia-gpu-arch-check": true,
    measres: "success",
    secboot: true,
    "x-nvidia-gpu-driver-version": "580.95.05",
    "x-nvidia-gpu-vbios-version": "97.00.88.00.0F",
    "x-nvidia-gpu-architecture": "BLACKWELL",
  };
}

describe("nv-cc GPU attestation", () => {
  it("validates passing nvattest claims against policy", () => {
    const policy = {
      ...DEFAULT_GPU_ATTESTATION_POLICY,
      allowedGpuArchitectures: new Set(["blackwell"]),
    };
    const verdict = validateNvGpuClaimsAgainstPolicy(passingGpuClaims(), policy);
    expect(verdict.ok).toBe(true);
  });

  it("accepts nvattest 1.2.x nested cert-chain and rim schema claims", () => {
    const policy = {
      ...DEFAULT_GPU_ATTESTATION_POLICY,
      allowedGpuDriverVersions: new Set(["595.71.05"]),
      allowedGpuVbiosVersions: new Set(["98.02.8d.00.01"]),
      allowedGpuArchitectures: new Set(["blackwell"]),
    };
    const verdict = validateNvGpuClaimsAgainstPolicy(
      {
        "x-nvidia-gpu-driver-rim-signature-verified": true,
        "x-nvidia-gpu-vbios-rim-signature-verified": true,
        "x-nvidia-gpu-attestation-report-cert-chain": {
          "x-nvidia-cert-status": "valid",
          "x-nvidia-cert-ocsp-status": "good",
        },
        "x-nvidia-gpu-attestation-report-signature-verified": true,
        "x-nvidia-gpu-driver-rim-version-match": true,
        "x-nvidia-gpu-vbios-rim-version-match": true,
        "x-nvidia-gpu-arch-check": true,
        measres: "success",
        secboot: true,
        "x-nvidia-gpu-driver-version": "595.71.05",
        "x-nvidia-gpu-vbios-version": "98.02.8D.00.01",
        "x-nvidia-gpu-architecture": "BLACKWELL",
      },
      policy,
    );
    expect(verdict.ok).toBe(true);
  });

  it("rejects driver version outside allowlist", () => {
    const policy = {
      ...DEFAULT_GPU_ATTESTATION_POLICY,
      allowedGpuDriverVersions: new Set(["575.32"]),
    };
    const verdict = validateNvGpuClaimsAgainstPolicy(passingGpuClaims(), policy);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("gpu_driver_version_not_allowed");
  });

  it("accepts legacy mock evidence in fixture verifier", () => {
    expect(verifyMockNvCcGpuEvidence(encodeLegacyMockGpuEvidence()).ok).toBe(true);
  });

  it("rejects gpu-tee-pending placeholder in production verifier", () => {
    const pending = Buffer.from("gpu-tee-pending", "utf8").toString("base64url");
    const verdict = verifyNvCcGpuEvidence(pending, DEFAULT_GPU_ATTESTATION_POLICY, {
      env: { TEECHAT_BUILD: "production" },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("legacy_gpu_placeholder");
  });

  it("allows not-applicable GPU evidence when skipGpuVerification is set", () => {
    const verdict = verifyNvCcGpuEvidence(buildGpuNotApplicableEvidence(), DEFAULT_GPU_ATTESTATION_POLICY, {
      skipGpuVerification: true,
      env: { TEECHAT_BUILD: "production" },
    });
    expect(verdict.ok).toBe(true);
  });
});
