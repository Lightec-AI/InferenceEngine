import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface OpeIdentityMeasurements {
  version: string;
  gitSha: string;
  libopeFfiSha256: string;
}

export interface BinaryMeasurements {
  engineVersion: string;
  engineBinarySha256: string;
  vllmVersion: string;
  vllmBinarySha256: string;
  ope?: OpeIdentityMeasurements;
}

function sha256File(path: string): string {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

function readReleaseManifest(root: string): {
  opeFfiSha256?: string;
  version?: string;
  opeGitSha?: string;
  opeVersion?: string;
  opeReleaseTag?: string;
} | null {
  const path = join(root, "RELEASE_MANIFEST.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as {
      opeFfiSha256?: string;
      version?: string;
      opeGitSha?: string;
      opeVersion?: string;
      opeReleaseTag?: string;
    };
  } catch {
    return null;
  }
}

function readOpeVersionPin(root: string): {
  version?: string;
  gitSha?: string;
  libopeFfiSha256?: string;
} | null {
  const candidates = [
    join(root, "config", "ope-version.json"),
    join(root, "ope-version.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as {
        version?: string;
        gitSha?: string;
        libopeFfiSha256?: string;
      };
    } catch {
      // try next
    }
  }
  return null;
}

/** Resolve engine + vLLM (+ optional OPE) measurement hashes for attestation claims. */
export function resolveBinaryMeasurementsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  root = process.cwd(),
): BinaryMeasurements {
  const manifest = readReleaseManifest(root);
  const opePin = readOpeVersionPin(root);
  const engineSha = (
    env.TEECHAT_ENGINE_BINARY_SHA256 ??
    env.TEECHAT_OPE_FFI_SHA256 ??
    manifest?.opeFfiSha256 ??
    opePin?.libopeFfiSha256 ??
    ""
  )
    .trim()
    .toLowerCase();
  const engineVersion = (env.TEECHAT_ENGINE_BUILD_VERSION ?? manifest?.version ?? "prod").trim();

  let vllmSha = (env.TEECHAT_VLLM_BINARY_SHA256 ?? "").trim().toLowerCase();
  const vllmPath = (env.TEECHAT_VLLM_BINARY_PATH ?? "").trim();
  if (!vllmSha && vllmPath && existsSync(vllmPath)) {
    vllmSha = sha256File(vllmPath);
  }
  const vllmVersion = (env.TEECHAT_VLLM_BUILD_VERSION ?? "upstream").trim();

  if (!engineSha) {
    throw new Error(
      "TEECHAT_ENGINE_BINARY_SHA256 or TEECHAT_OPE_FFI_SHA256 (or RELEASE_MANIFEST.json) is required for SEV-SNP attestation",
    );
  }
  if (!vllmSha) {
    throw new Error(
      "TEECHAT_VLLM_BINARY_SHA256 or TEECHAT_VLLM_BINARY_PATH is required for SEV-SNP attestation",
    );
  }

  const opeVersion = (
    env.TEECHAT_OPE_VERSION ??
    manifest?.opeVersion ??
    opePin?.version ??
    ""
  ).trim();
  const opeGitSha = (
    env.TEECHAT_OPE_GIT_SHA ??
    manifest?.opeGitSha ??
    opePin?.gitSha ??
    ""
  ).trim();
  const opeFfiSha = (
    env.TEECHAT_OPE_FFI_SHA256 ??
    manifest?.opeFfiSha256 ??
    opePin?.libopeFfiSha256 ??
    engineSha
  )
    .trim()
    .toLowerCase();

  let ope: OpeIdentityMeasurements | undefined;
  if (opeVersion && opeGitSha && opeFfiSha) {
    if (opeFfiSha !== engineSha) {
      throw new Error(
        `OPE FFI hash (${opeFfiSha}) must equal engine binary measurement (${engineSha})`,
      );
    }
    ope = {
      version: opeVersion,
      gitSha: opeGitSha,
      libopeFfiSha256: opeFfiSha,
    };
  }

  return {
    engineVersion,
    engineBinarySha256: engineSha,
    vllmVersion,
    vllmBinarySha256: vllmSha,
    ope,
  };
}
