import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GatewayMtlsTlsMaterial } from "../client/gateway-mtls.js";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

function sha256CertPem(pem: string): string {
  return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
}

function readPem(env: NodeJS.ProcessEnv, envKey: string, fixtureName: string): string {
  const fromEnv = env[envKey]?.trim();
  if (fromEnv) {
    if (fromEnv.includes("-----BEGIN")) return fromEnv;
    return readFileSync(resolve(fromEnv), "utf8");
  }
  // Prefer TeeChat monorepo fixtures when present; else empty (caller must set env).
  const candidates = [
    resolve(process.cwd(), "server/gateway/mtls/fixtures", fixtureName),
    resolve(here, "../../../../server/gateway/mtls/fixtures", fixtureName),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`missing ${envKey} and fixture ${fixtureName}`);
}

export interface EngineClientTlsMaterial extends GatewayMtlsTlsMaterial {
  clientCertSha256: string;
}

/** Engine-plane client TLS; prefers audited attested-mtls native loader. */
export function loadEnginePlaneClientTls(
  env: NodeJS.ProcessEnv = process.env,
): EngineClientTlsMaterial {
  try {
    const mod = require("@teechat/attested-mtls-node") as {
      loadEngineClientTlsFromEnv: (
        envMap: Record<string, string>,
        defaults?: {
          ca_cert_pem: string;
          client_cert_pem: string;
          client_key_pem: string;
          client_cert_sha256: string;
        } | null,
      ) => {
        ca_cert_pem: string;
        client_cert_pem: string;
        client_key_pem: string;
        client_cert_sha256: string;
      };
    };
    const envMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string" && v.length > 0) envMap[k] = v;
    }
    const ca = readPem(env, "TEECHAT_GATEWAY_ENGINE_TLS_CA_PEM", "dev-ca.pem");
    const cert = readPem(env, "TEECHAT_GATEWAY_ENGINE_TLS_CLIENT_CERT_PEM", "dev-client.pem");
    const key = readPem(env, "TEECHAT_GATEWAY_ENGINE_TLS_CLIENT_KEY_PEM", "dev-client.key.pem");
    const defaults = {
      ca_cert_pem: ca,
      client_cert_pem: cert,
      client_key_pem: key,
      client_cert_sha256: sha256CertPem(cert),
    };
    const mat = mod.loadEngineClientTlsFromEnv(envMap, defaults);
    return {
      caCertPem: mat.ca_cert_pem,
      clientCertPem: mat.client_cert_pem,
      clientKeyPem: mat.client_key_pem,
      clientCertSha256: mat.client_cert_sha256,
    };
  } catch {
    const caCertPem = readPem(env, "TEECHAT_GATEWAY_ENGINE_TLS_CA_PEM", "dev-ca.pem");
    const clientCertPem = readPem(
      env,
      "TEECHAT_GATEWAY_ENGINE_TLS_CLIENT_CERT_PEM",
      "dev-client.pem",
    );
    const clientKeyPem = readPem(
      env,
      "TEECHAT_GATEWAY_ENGINE_TLS_CLIENT_KEY_PEM",
      "dev-client.key.pem",
    );
    return {
      caCertPem,
      clientCertPem,
      clientKeyPem,
      clientCertSha256: sha256CertPem(clientCertPem),
    };
  }
}
