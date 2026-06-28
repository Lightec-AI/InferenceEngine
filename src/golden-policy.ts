/** L1/L2 golden-image fields carried in quote claims and attestation policy (CVM Phase 2). */

export interface GoldenImageClaims {
  golden_image_version?: string;
  launch_digest?: string;
  rootfs_verity_sha256?: string;
  venv_manifest_sha256?: string;
}

export interface GoldenAttestationPolicy {
  goldenImageVersion?: string;
  allowedLaunchDigests: ReadonlySet<string>;
  allowedRootfsVeritySha256: ReadonlySet<string>;
  allowedVenvManifestSha256: ReadonlySet<string>;
  requireLaunchDigest: boolean;
  requireRootfsVerity: boolean;
  requireVenvManifest: boolean;
}

export const EMPTY_GOLDEN_ATTESTATION_POLICY: GoldenAttestationPolicy = {
  allowedLaunchDigests: new Set(),
  allowedRootfsVeritySha256: new Set(),
  allowedVenvManifestSha256: new Set(),
  requireLaunchDigest: false,
  requireRootfsVerity: false,
  requireVenvManifest: false,
};

const HEX64 = /^[0-9a-f]{64}$/;

function normHex(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normOptionalString(value: string | undefined): string | undefined {
  const s = (value ?? "").trim();
  return s || undefined;
}

function assertOptionalHex64(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`attestation_policy_invalid:${field}`);
  const h = value.trim().toLowerCase();
  if (!HEX64.test(h)) throw new Error(`attestation_policy_invalid:${field}_hex`);
  return h;
}

function assertOptionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error(`attestation_policy_invalid:${field}`);
  }
  return (value as string[]).map((s) => s.trim().toLowerCase()).filter((h) => HEX64.test(h));
}

export interface GoldenAttestationPolicyFileJson {
  goldenImageVersion?: string;
  allowedLaunchDigests?: string[];
  allowedRootfsVeritySha256?: string[];
  allowedVenvManifestSha256?: string[];
  requireLaunchDigest?: boolean;
  requireRootfsVerity?: boolean;
  requireVenvManifest?: boolean;
}

export function parseGoldenAttestationPolicyFromJson(
  rec: GoldenAttestationPolicyFileJson,
): GoldenAttestationPolicy {
  return {
    goldenImageVersion: normOptionalString(rec.goldenImageVersion),
    allowedLaunchDigests: new Set(assertOptionalStringArray(rec.allowedLaunchDigests, "allowedLaunchDigests")),
    allowedRootfsVeritySha256: new Set(
      assertOptionalStringArray(rec.allowedRootfsVeritySha256, "allowedRootfsVeritySha256"),
    ),
    allowedVenvManifestSha256: new Set(
      assertOptionalStringArray(rec.allowedVenvManifestSha256, "allowedVenvManifestSha256"),
    ),
    requireLaunchDigest: rec.requireLaunchDigest === true,
    requireRootfsVerity: rec.requireRootfsVerity === true,
    requireVenvManifest: rec.requireVenvManifest === true,
  };
}

export function goldenPolicyIsActive(policy: GoldenAttestationPolicy | undefined): boolean {
  if (!policy) return false;
  return (
    policy.requireLaunchDigest ||
    policy.requireRootfsVerity ||
    policy.requireVenvManifest ||
    policy.allowedLaunchDigests.size > 0 ||
    policy.allowedRootfsVeritySha256.size > 0 ||
    policy.allowedVenvManifestSha256.size > 0 ||
    Boolean(policy.goldenImageVersion)
  );
}

export function resolveGoldenImageMeasurementsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GoldenImageClaims | undefined {
  const golden_image_version = normOptionalString(env.TEECHAT_GOLDEN_IMAGE_VERSION);
  const launch_digest = envHex(env.TEECHAT_ENGINE_LAUNCH_DIGEST);
  const rootfs_verity_sha256 = envHex(env.TEECHAT_ENGINE_ROOTFS_VERITY_SHA256);
  const venv_manifest_sha256 = envHex(env.TEECHAT_VLLM_VENV_MANIFEST_SHA256);
  if (!golden_image_version && !launch_digest && !rootfs_verity_sha256 && !venv_manifest_sha256) {
    return undefined;
  }
  return {
    golden_image_version,
    launch_digest,
    rootfs_verity_sha256,
    venv_manifest_sha256,
  };
}

function envHex(value: string | undefined): string | undefined {
  const h = normHex(value);
  return HEX64.test(h) ? h : undefined;
}

export function verifyGoldenImageClaimsAgainstPolicy(
  claims: GoldenImageClaims | undefined,
  policy: GoldenAttestationPolicy | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!goldenPolicyIsActive(policy)) return { ok: true };
  const p = policy!;

  if (p.goldenImageVersion) {
    const version = (claims?.golden_image_version ?? "").trim();
    if (!version || version !== p.goldenImageVersion) {
      return { ok: false, reason: "golden_image_version_mismatch" };
    }
  }

  const launch = normHex(claims?.launch_digest);
  if (p.requireLaunchDigest) {
    if (!launch) return { ok: false, reason: "launch_digest_required" };
    if (p.allowedLaunchDigests.size === 0) return { ok: false, reason: "launch_digest_required" };
    if (!p.allowedLaunchDigests.has(launch)) return { ok: false, reason: "launch_digest_mismatch" };
  } else if (p.allowedLaunchDigests.size > 0) {
    if (!launch || !p.allowedLaunchDigests.has(launch)) {
      return { ok: false, reason: "launch_digest_mismatch" };
    }
  }

  const rootfs = normHex(claims?.rootfs_verity_sha256);
  if (p.requireRootfsVerity) {
    if (!rootfs) return { ok: false, reason: "rootfs_verity_required" };
    if (p.allowedRootfsVeritySha256.size === 0) return { ok: false, reason: "rootfs_verity_required" };
    if (!p.allowedRootfsVeritySha256.has(rootfs)) return { ok: false, reason: "rootfs_verity_mismatch" };
  } else if (p.allowedRootfsVeritySha256.size > 0) {
    if (!rootfs || !p.allowedRootfsVeritySha256.has(rootfs)) {
      return { ok: false, reason: "rootfs_verity_mismatch" };
    }
  }

  const venv = normHex(claims?.venv_manifest_sha256);
  if (p.requireVenvManifest) {
    if (!venv) return { ok: false, reason: "venv_manifest_required" };
    if (p.allowedVenvManifestSha256.size === 0) return { ok: false, reason: "venv_manifest_required" };
    if (!p.allowedVenvManifestSha256.has(venv)) return { ok: false, reason: "venv_manifest_mismatch" };
  } else if (p.allowedVenvManifestSha256.size > 0) {
    if (!venv || !p.allowedVenvManifestSha256.has(venv)) {
      return { ok: false, reason: "venv_manifest_mismatch" };
    }
  }

  return { ok: true };
}
