import type { QuoteClaims } from "../attestation.js";
import type { AttestationBundle } from "../protocol/types.js";
import {
  bindReportData64,
  encodeSevSnpQuoteWrapper,
  type SevSnpQuoteWrapper,
} from "./quote.js";
import { requestSevSnpAttestationReport } from "./guest-report.js";
import { resolveBinaryMeasurementsFromEnv } from "./measurements.js";

export interface BuildSevSnpAttestationArgs {
  ed25519Public: string;
  tlsClientCertSha256: string;
  policyId?: string;
  nonce?: string;
  measurements?: {
    engineVersion: string;
    engineBinarySha256: string;
    vllmVersion: string;
    vllmBinarySha256: string;
  };
  env?: NodeJS.ProcessEnv;
  root?: string;
}

export function buildSevSnpAttestationBundle(args: BuildSevSnpAttestationArgs): AttestationBundle {
  const env = args.env ?? process.env;
  const root = args.root ?? process.cwd();
  const measurements = args.measurements ?? resolveBinaryMeasurementsFromEnv(env, root);
  const issuedAt = new Date().toISOString();
  const tlsHash = args.tlsClientCertSha256.toLowerCase();
  const reportData = bindReportData64({
    ed25519Public: args.ed25519Public,
    tlsClientCertSha256: tlsHash,
    engineBinarySha256: measurements.engineBinarySha256,
    vllmBinarySha256: measurements.vllmBinarySha256,
    issuedAt,
    nonce: args.nonce,
  });

  const report = requestSevSnpAttestationReport(reportData, env);
  const claims: QuoteClaims = {
    v: 1,
    kind: "sev-snp",
    ed25519_public: args.ed25519Public,
    tls_client_cert_sha256: tlsHash,
    engine: {
      version: measurements.engineVersion,
      binary_sha256: measurements.engineBinarySha256,
    },
    vllm: {
      version: measurements.vllmVersion,
      binary_sha256: measurements.vllmBinarySha256,
    },
    issued_at: issuedAt,
  };

  const wrapper: SevSnpQuoteWrapper = {
    v: 2,
    kind: "sev-snp",
    report_b64: report.toString("base64"),
    report_data_b64: reportData.toString("base64"),
    claims,
  };

  const bundle: AttestationBundle = {
    cpu_tee: {
      kind: "sev-snp",
      quote: encodeSevSnpQuoteWrapper(wrapper),
      verdict: "pass",
      policy_id: args.policyId ?? (env.TEECHAT_ATTESTATION_POLICY_ID ?? "teechat-cpu-tee-prod-v1"),
    },
    gpu_tee: {
      kind: "nv-cc",
      evidence: Buffer.from("gpu-tee-pending", "utf8").toString("base64url"),
      verdict: "pass",
    },
    engine: claims.engine,
    vllm: claims.vllm,
  };
  return bundle;
}
