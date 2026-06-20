import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_RIM_SERVICE_URL = "https://rim.attestation.nvidia.com";
export const DEFAULT_OCSP_SERVICE_URL = "https://ocsp.ndis.nvidia.com";

export function nvattestBinFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.TEECHAT_NVATTEST_BIN ?? env.NVATTEST_BIN ?? "nvattest").trim() || "nvattest";
}

export function rimServiceBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.TEECHAT_NV_RIM_SERVICE_URL ?? DEFAULT_RIM_SERVICE_URL).trim() || DEFAULT_RIM_SERVICE_URL;
}

export function ocspServiceBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.TEECHAT_NV_OCSP_SERVICE_URL ?? DEFAULT_OCSP_SERVICE_URL).trim() || DEFAULT_OCSP_SERVICE_URL;
}

/** Local RIM collateral cache for air-gapped guests (ops rsync / prefetch). */
export function rimCacheDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const dir = (env.TEECHAT_NV_RIM_CACHE_DIR ?? "/var/cache/teechat/nv-rim").trim();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function rimCachePathForId(rimId: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe = rimId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return join(rimCacheDirFromEnv(env), `${safe}.xml`);
}

/** Append NVIDIA attestation CLI service URLs for `nvattest attest` (not collect-evidence). */
export function appendNvattestAttestArgs(args: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const out = [...args];
  const rim = rimServiceBaseUrl(env);
  const ocsp = ocspServiceBaseUrl(env);
  if (rim) {
    out.push("--rim-url", rim);
  }
  if (ocsp) {
    out.push("--ocsp-url", ocsp);
  }
  return out;
}
