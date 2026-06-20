/**
 * Browser-safe engine trust verification (mock attestation + epoch checks).
 * No Node `crypto` or `ope-ffi` — suitable for web/Capacitor.
 */

import type { AttestationBundle, EngineTrustBundle } from "./protocol/types.js";
import {
  decodeNvCcGpuEvidenceEnvelope,
  isLegacyMockGpuEvidence,
  LEGACY_MOCK_GPU_EVIDENCE_UTF8,
} from "./nv-cc/encode.js";

export interface BrowserAttestationPolicy {
  policyId: string;
  allowedEngineBinarySha256: ReadonlySet<string>;
  allowedVllmBinarySha256: ReadonlySet<string>;
  maxQuoteAgeMs: number;
}

export const DEFAULT_BROWSER_TEST_ATTESTATION_POLICY: BrowserAttestationPolicy = {
  policyId: "teechat-cpu-tee-v1",
  allowedEngineBinarySha256: new Set([
    "a1b2c3d4e5f6789012345678abcdef9012345678abcdef9012345678abcdef90",
  ]),
  allowedVllmBinarySha256: new Set([
    "b2c3d4e5f6789012345678abcdef9012345678abcdef9012345678abcdef9012",
  ]),
  maxQuoteAgeMs: 24 * 60 * 60 * 1000,
};

export interface BrowserTrustVerifyResult {
  ok: boolean;
  reason?: string;
}

export type TrustSignatureSigner = "intel" | "amd" | "nvidia" | "engine";

type CpuTeeKind = "tdx" | "sev-snp";

function cpuSignerForKind(kind: CpuTeeKind): "intel" | "amd" {
  return kind === "sev-snp" ? "amd" : "intel";
}

function cpuSignatureAlgorithm(kind: CpuTeeKind, mock: boolean): string {
  if (kind === "sev-snp") {
    return mock
      ? "SEV-SNP report — HMAC-SHA256 (dev mock)"
      : "SEV-SNP report — AMD ARK/ASK/VCEK chain (production)";
  }
  return mock ? "TDX quote — HMAC-SHA256 (dev mock)" : "TDX quote — Intel PCS/PCK chain (production)";
}

function cpuSignatureDetail(kind: CpuTeeKind, failed: boolean): string {
  if (failed) return "CPU quote signature could not be verified";
  if (kind === "sev-snp") {
    return "Production verifies AMD-signed SEV-SNP report via KDS ARK/ASK/VCEK collateral (see AMD trust reference links in Settings).";
  }
  return "Production verifies Intel-signed quote via PCS/PCK collateral (see Intel trust reference links in Settings).";
}

function pushCpuQuoteSignature(
  signatures: TrustSignatureVerification[],
  kind: CpuTeeKind,
  status: TrustSignatureStatus,
): void {
  signatures.push({
    signer: cpuSignerForKind(kind),
    status,
    algorithm: cpuSignatureAlgorithm(kind, status === "mock_dev"),
    detail: cpuSignatureDetail(kind, status === "failed"),
  });
}

export type TrustSignatureStatus = "verified" | "failed" | "mock_dev" | "pending_production";

/** One row in client trust evidence (signature chain / identity binding). */
export interface TrustSignatureVerification {
  signer: TrustSignatureSigner;
  status: TrustSignatureStatus;
  /** Human-readable algorithm or chain description. */
  algorithm: string;
  detail?: string;
}

export interface BrowserTrustEvidence {
  /** `mock_dev` until production TDX / NVIDIA verifiers are wired in the browser. */
  mode: "mock_dev" | "production";
  cpuKind: string;
  gpuKind: string;
  cpuPolicyId: string;
  quoteIssuedAt?: string;
  signatures: TrustSignatureVerification[];
}

export interface BrowserTrustVerifyDetailedResult extends BrowserTrustVerifyResult {
  evidence?: BrowserTrustEvidence;
}

const MOCK_ATTEST_HMAC_SECRET = new TextEncoder().encode("teechat-mock-ope-attest-v1");

function base64UrlToBytes(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

interface QuoteClaims {
  v: number;
  kind: "tdx" | "sev-snp";
  ed25519_public: string;
  tls_client_cert_sha256: string;
  engine: { version: string; binary_sha256: string };
  vllm: { version: string; binary_sha256: string };
  issued_at: string;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
  return new Uint8Array(sig);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function parseMockCpuQuote(quote: string): Promise<QuoteClaims | null> {
  try {
    const raw = base64UrlToBytes(quote);
    if (raw.length < 33) return null;
    const body = raw.subarray(0, raw.length - 32);
    const mac = raw.subarray(raw.length - 32);
    const expected = await hmacSha256(MOCK_ATTEST_HMAC_SECRET, body);
    if (!timingSafeEqual(mac, expected)) return null;
    const text = new TextDecoder().decode(body);
    return JSON.parse(text) as QuoteClaims;
  } catch {
    return null;
  }
}

const MOCK_GPU_EVIDENCE_UTF8 = LEGACY_MOCK_GPU_EVIDENCE_UTF8;

function verifyMockGpuEvidence(evidenceB64: string, skipGpuVerification: boolean): boolean {
  if (skipGpuVerification) {
    const envelope = decodeNvCcGpuEvidenceEnvelope(evidenceB64);
    if (envelope?.not_applicable) return true;
    return isLegacyMockGpuEvidence(evidenceB64);
  }
  try {
    if (isLegacyMockGpuEvidence(evidenceB64)) return true;
    const envelope = decodeNvCcGpuEvidenceEnvelope(evidenceB64);
    return envelope?.source === "mock";
  } catch {
    return false;
  }
}

async function verifyAttestationBundleBrowser(
  bundle: AttestationBundle,
  policy: BrowserAttestationPolicy,
  bind: { ed25519Public: string; tlsClientCertSha256: string },
  nowMs: number,
  skipTlsCertBinding: boolean,
  skipGpuVerification: boolean,
): Promise<BrowserTrustVerifyDetailedResult> {
  const signatures: TrustSignatureVerification[] = [];
  const cpuKind = bundle.cpu_tee.kind as CpuTeeKind;
  const payload = await parseMockCpuQuote(bundle.cpu_tee.quote);
  if (!payload) {
    pushCpuQuoteSignature(signatures, cpuKind, "failed");
    return { ok: false, reason: "invalid_cpu_quote", evidence: buildEvidence(bundle, signatures) };
  }
  const quoteKind = payload.kind as CpuTeeKind;
  pushCpuQuoteSignature(signatures, quoteKind, "mock_dev");
  if (payload.v !== 1) {
    return {
      ok: false,
      reason: "unsupported_quote_version",
      evidence: buildEvidence(bundle, signatures, payload.issued_at),
    };
  }
  if (payload.ed25519_public !== bind.ed25519Public) {
    return { ok: false, reason: "ed25519_mismatch", evidence: buildEvidence(bundle, signatures, payload.issued_at) };
  }
  if (
    !skipTlsCertBinding &&
    payload.tls_client_cert_sha256.toLowerCase() !== bind.tlsClientCertSha256.toLowerCase()
  ) {
    return { ok: false, reason: "tls_cert_mismatch", evidence: buildEvidence(bundle, signatures, payload.issued_at) };
  }
  const issued = Date.parse(payload.issued_at);
  if (Number.isNaN(issued) || nowMs - issued > policy.maxQuoteAgeMs) {
    return { ok: false, reason: "quote_stale", evidence: buildEvidence(bundle, signatures, payload.issued_at) };
  }
  if (!policy.allowedEngineBinarySha256.has(payload.engine.binary_sha256)) {
    return {
      ok: false,
      reason: "engine_hash_not_allowed",
      evidence: buildEvidence(bundle, signatures, payload.issued_at),
    };
  }
  if (!policy.allowedVllmBinarySha256.has(payload.vllm.binary_sha256)) {
    return {
      ok: false,
      reason: "vllm_hash_not_allowed",
      evidence: buildEvidence(bundle, signatures, payload.issued_at),
    };
  }
  if (bundle.engine.binary_sha256 !== payload.engine.binary_sha256) {
    return {
      ok: false,
      reason: "engine_hash_bundle_mismatch",
      evidence: buildEvidence(bundle, signatures, payload.issued_at),
    };
  }
  if (bundle.vllm.binary_sha256 !== payload.vllm.binary_sha256) {
    return {
      ok: false,
      reason: "vllm_hash_bundle_mismatch",
      evidence: buildEvidence(bundle, signatures, payload.issued_at),
    };
  }

  const gpuOk = verifyMockGpuEvidence(bundle.gpu_tee.evidence, skipGpuVerification);
  signatures.push({
    signer: "nvidia",
    status: gpuOk ? (skipGpuVerification ? "verified" : "mock_dev") : "failed",
    algorithm: gpuOk
      ? skipGpuVerification
        ? "GPU confidential — not applicable (gateway platform)"
        : "GPU confidential — mock evidence (dev)"
      : "GPU confidential — evidence signature",
    detail: gpuOk
      ? "Production verifies NVIDIA RIM / attestation report chain (see NVIDIA trust reference links in Settings)."
      : "GPU attestation evidence failed verification",
  });
  if (!gpuOk) {
    return { ok: false, reason: "invalid_gpu_evidence", evidence: buildEvidence(bundle, signatures, payload.issued_at) };
  }

  if (bundle.cpu_tee.verdict !== "pass" || bundle.gpu_tee.verdict !== "pass") {
    return { ok: false, reason: "verdict_not_pass", evidence: buildEvidence(bundle, signatures, payload.issued_at) };
  }
  return { ok: true, evidence: buildEvidence(bundle, signatures, payload.issued_at) };
}

function buildEvidence(
  bundle: AttestationBundle,
  signatures: TrustSignatureVerification[],
  quoteIssuedAt?: string,
): BrowserTrustEvidence {
  return {
    mode: "mock_dev",
    cpuKind: bundle.cpu_tee.kind,
    gpuKind: bundle.gpu_tee.kind,
    cpuPolicyId: bundle.cpu_tee.policy_id,
    quoteIssuedAt,
    signatures: [...signatures],
  };
}

function ephemeralSigningBytes(args: {
  engineId: string;
  epochId: string;
  notAfter: string;
  hybrid: EngineTrustBundle["hybrid"];
}): Uint8Array {
  const parts = [
    "OPE-ENGINE-EPHEMERAL-v1",
    args.engineId,
    args.epochId,
    args.notAfter,
    args.hybrid.mlkem_encapsulation_key,
    args.hybrid.x25519_public,
  ];
  return new TextEncoder().encode(parts.join("\u0000"));
}

async function verifyEphemeralIdentitySignatureBrowser(
  ed25519PublicBase64Url: string,
  req: Pick<EngineTrustBundle, "engine_id" | "epoch_id" | "not_after" | "hybrid" | "identity">,
): Promise<boolean> {
  const msg = ephemeralSigningBytes({
    engineId: req.engine_id,
    epochId: req.epoch_id,
    notAfter: req.not_after,
    hybrid: req.hybrid,
  });
  const sig = base64UrlToBytes(req.identity.identity_signature);
  if (sig.length !== 64) return false;
  const pk = base64UrlToBytes(ed25519PublicBase64Url);
  if (pk.length !== 32) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      pk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify({ name: "Ed25519" }, key, sig, msg);
  } catch {
    return false;
  }
}

function isEpochActive(notBefore: string, notAfter: string, nowMs: number): boolean {
  const start = Date.parse(notBefore);
  const end = Date.parse(notAfter);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return nowMs >= start && nowMs <= end;
}

export interface VerifyEngineTrustBundleBrowserOptions {
  skipTlsCertBinding?: boolean;
  skipGpuVerification?: boolean;
  /** Platform attestation (SEC-029) has no ephemeral epoch signature. */
  skipIdentitySignature?: boolean;
}

/** Client-side trust bundle verification for browsers (dev mock attestation). */
export async function verifyEngineTrustBundleBrowser(
  bundle: EngineTrustBundle,
  policy: BrowserAttestationPolicy,
  tlsClientCertSha256: string,
  nowMs = Date.now(),
  opts: VerifyEngineTrustBundleBrowserOptions = {},
): Promise<BrowserTrustVerifyDetailedResult> {
  return verifyEngineTrustBundleBrowserDetailed(bundle, policy, tlsClientCertSha256, nowMs, opts);
}

/** Verify trust bundle and return per-signer evidence for client UI (C-7). */
export async function verifyEngineTrustBundleBrowserDetailed(
  bundle: EngineTrustBundle,
  policy: BrowserAttestationPolicy,
  tlsClientCertSha256: string,
  nowMs = Date.now(),
  opts: VerifyEngineTrustBundleBrowserOptions = {},
): Promise<BrowserTrustVerifyDetailedResult> {
  const attest = await verifyAttestationBundleBrowser(
    bundle.attestation,
    policy,
    {
      ed25519Public: bundle.identity.ed25519_public,
      tlsClientCertSha256,
    },
    nowMs,
    opts.skipTlsCertBinding ?? false,
    opts.skipGpuVerification ?? false,
  );
  const evidence =
    attest.evidence ?? buildEvidence(bundle.attestation, []);

  if (!attest.ok) return { ok: false, reason: attest.reason, evidence };

  if (!opts.skipIdentitySignature && !isEpochActive(bundle.not_before, bundle.not_after, nowMs)) {
    return { ok: false, reason: "epoch_expired", evidence };
  }

  if (opts.skipIdentitySignature) {
    return { ok: true, evidence };
  }

  const sigOk = await verifyEphemeralIdentitySignatureBrowser(
    bundle.identity.ed25519_public,
    bundle,
  );
  const engineSig: TrustSignatureVerification = {
    signer: "engine",
    status: sigOk ? "verified" : "failed",
    algorithm: "Ed25519 — OPE-ENGINE-EPHEMERAL-v1",
    detail: sigOk
      ? "Ephemeral epoch keys signed by engine identity public key"
      : "Ephemeral identity signature invalid",
  };
  const signatures = [...evidence.signatures, engineSig];
  const fullEvidence: BrowserTrustEvidence = { ...evidence, signatures };

  if (!sigOk) return { ok: false, reason: "invalid_identity_signature", evidence: fullEvidence };

  return { ok: true, evidence: fullEvidence };
}

export type { EngineTrustBundle };
