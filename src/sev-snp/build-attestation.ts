import type { QuoteClaims } from "../attestation.js";
import type { AttestationBundle } from "../protocol/types.js";
import {
  bindReportData64,
  encodeSevSnpQuoteWrapper,
  type SevSnpQuoteWrapper,
} from "./quote.js";
import { requestSevSnpAttestationReport } from "./guest-report.js";
import { resolveBinaryMeasurementsFromEnv } from "./measurements.js";
import { collectNvCcGpuEvidenceB64 } from "../nv-cc/collect.js";

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
    ope?: { version: string; gitSha: string; libopeFfiSha256: string };
    attestedMtls?: { version: string; gitSha: string; libAttestedMtlsSha256: string };
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
  const gpuNonce = reportData.subarray(0, 32).toString("hex");
  const gpuEvidence = collectNvCcGpuEvidenceB64({ env, nonce: gpuNonce });
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
  if (measurements.ope) {
    claims.ope = {
      version: measurements.ope.version,
      git_sha: measurements.ope.gitSha,
      libope_ffi_sha256: measurements.ope.libopeFfiSha256,
    };
  }
  if (measurements.attestedMtls) {
    claims.attested_mtls = {
      version: measurements.attestedMtls.version,
      git_sha: measurements.attestedMtls.gitSha,
      lib_attested_mtls_sha256: measurements.attestedMtls.libAttestedMtlsSha256,
    };
  }

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
      evidence: gpuEvidence,
      verdict: "pass",
    },
    engine: claims.engine,
    vllm: claims.vllm,
  };
  if (claims.ope) {
    bundle.ope = claims.ope;
  }
  if (claims.attested_mtls) {
    bundle.attested_mtls = claims.attested_mtls;
  }
  return bundle;
}
