import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface OpeIdentityMeasurements {
  version: string;
  gitSha: string;
  libopeFfiSha256: string;
}

export interface AttestedMtlsIdentityMeasurements {
  version: string;
  gitSha: string;
  libAttestedMtlsSha256: string;
}

export interface BinaryMeasurements {
  engineVersion: string;
  engineBinarySha256: string;
  vllmVersion: string;
  vllmBinarySha256: string;
  ope?: OpeIdentityMeasurements;
  attestedMtls?: AttestedMtlsIdentityMeasurements;
}

function sha256File(path: string): string {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

function readReleaseManifest(root: string): {
  ieRuntimeSha256?: string;
  opeFfiSha256?: string;
  attestedMtlsSha256?: string;
  version?: string;
  opeGitSha?: string;
  opeVersion?: string;
  attestedMtlsVersion?: string;
  attestedMtlsTag?: string;
} | null {
  const path = join(root, "RELEASE_MANIFEST.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as {
      ieRuntimeSha256?: string;
      opeFfiSha256?: string;
      attestedMtlsSha256?: string;
      version?: string;
      opeGitSha?: string;
      opeVersion?: string;
      attestedMtlsVersion?: string;
      attestedMtlsTag?: string;
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

function readAttestedMtlsPin(root: string): {
  version?: string;
  gitSha?: string;
  libAttestedMtlsSha256?: string;
} | null {
  const candidates = [
    join(root, "config", "attested-mtls-version.json"),
    join(root, "attested-mtls-version.json"),
    join(root, "tcb-pins.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (raw.attestedMtls && typeof raw.attestedMtls === "object") {
        const a = raw.attestedMtls as Record<string, string>;
        return {
          version: a.version,
          gitSha: a.gitSha,
          libAttestedMtlsSha256: a.libAttestedMtlsSha256,
        };
      }
      return {
        version: (raw.version as string) || undefined,
        gitSha: (raw.gitSha as string) || undefined,
        libAttestedMtlsSha256: (raw.libAttestedMtlsSha256 as string) || undefined,
      };
    } catch {
      // try next
    }
  }
  return null;
}

function readTcbPins(root: string): {
  ope?: { version?: string; gitSha?: string; libopeFfiSha256?: string };
  attestedMtls?: { version?: string; gitSha?: string; libAttestedMtlsSha256?: string };
} | null {
  const path = join(root, "config", "tcb-pins.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as {
      ope?: { version?: string; gitSha?: string; libopeFfiSha256?: string };
      attestedMtls?: { version?: string; gitSha?: string; libAttestedMtlsSha256?: string };
    };
  } catch {
    return null;
  }
}

/**
 * Resolve engine runtime + vLLM + independent OPE / attested-mtls measurement hashes.
 * `engine.binary_sha256` is the IE runtime tarball/bundle — not libope_ffi.so.
 */
export function resolveBinaryMeasurementsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  root = process.cwd(),
): BinaryMeasurements {
  const manifest = readReleaseManifest(root);
  const opePin = readOpeVersionPin(root);
  const amtPin = readAttestedMtlsPin(root);
  const tcb = readTcbPins(root);

  const engineSha = (
    env.TEECHAT_ENGINE_BINARY_SHA256 ??
    env.TEECHAT_IE_RUNTIME_SHA256 ??
    manifest?.ieRuntimeSha256 ??
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
      "TEECHAT_ENGINE_BINARY_SHA256 / TEECHAT_IE_RUNTIME_SHA256 (or RELEASE_MANIFEST.json ieRuntimeSha256) is required for SEV-SNP attestation",
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
    tcb?.ope?.version ??
    ""
  ).trim();
  const opeGitSha = (
    env.TEECHAT_OPE_GIT_SHA ??
    manifest?.opeGitSha ??
    opePin?.gitSha ??
    tcb?.ope?.gitSha ??
    ""
  ).trim();
  const opeFfiSha = (
    env.TEECHAT_OPE_FFI_SHA256 ??
    manifest?.opeFfiSha256 ??
    opePin?.libopeFfiSha256 ??
    tcb?.ope?.libopeFfiSha256 ??
    ""
  )
    .trim()
    .toLowerCase();

  let ope: OpeIdentityMeasurements | undefined;
  if (opeVersion && opeFfiSha) {
    ope = {
      version: opeVersion,
      gitSha: opeGitSha || "unknown",
      libopeFfiSha256: opeFfiSha,
    };
  }

  const amtVersion = (
    env.TEECHAT_ATTESTED_MTLS_VERSION ??
    manifest?.attestedMtlsVersion ??
    amtPin?.version ??
    tcb?.attestedMtls?.version ??
    ""
  ).trim();
  const amtGitSha = (
    env.TEECHAT_ATTESTED_MTLS_GIT_SHA ??
    amtPin?.gitSha ??
    tcb?.attestedMtls?.gitSha ??
    ""
  ).trim();
  const amtSha = (
    env.TEECHAT_ATTESTED_MTLS_SHA256 ??
    manifest?.attestedMtlsSha256 ??
    amtPin?.libAttestedMtlsSha256 ??
    tcb?.attestedMtls?.libAttestedMtlsSha256 ??
    ""
  )
    .trim()
    .toLowerCase();

  let attestedMtls: AttestedMtlsIdentityMeasurements | undefined;
  if (amtVersion && amtSha) {
    attestedMtls = {
      version: amtVersion,
      gitSha: amtGitSha || "unknown",
      libAttestedMtlsSha256: amtSha,
    };
  }

  return {
    engineVersion,
    engineBinarySha256: engineSha,
    vllmVersion,
    vllmBinarySha256: vllmSha,
    ope,
    attestedMtls,
  };
}
