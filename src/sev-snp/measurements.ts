import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BinaryMeasurements {
  engineVersion: string;
  engineBinarySha256: string;
  vllmVersion: string;
  vllmBinarySha256: string;
}

function sha256File(path: string): string {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

function readReleaseManifest(root: string): { opeFfiSha256?: string; version?: string } | null {
  const path = join(root, "RELEASE_MANIFEST.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as {
      opeFfiSha256?: string;
      version?: string;
    };
  } catch {
    return null;
  }
}

/** Resolve engine + vLLM measurement hashes for attestation claims (env overrides manifest). */
export function resolveBinaryMeasurementsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  root = process.cwd(),
): BinaryMeasurements {
  const manifest = readReleaseManifest(root);
  const engineSha = (
    env.TEECHAT_ENGINE_BINARY_SHA256 ??
    env.TEECHAT_OPE_FFI_SHA256 ??
    manifest?.opeFfiSha256 ??
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

  return {
    engineVersion,
    engineBinarySha256: engineSha,
    vllmVersion,
    vllmBinarySha256: vllmSha,
  };
}
