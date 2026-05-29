import { createHmac, timingSafeEqual } from "node:crypto";

import { mockAllowed } from "./build-mode.js";
import type { AttestationBundle, EngineRegisterRequest } from "./protocol/types.js";
import { bytesToBase64Url } from "./crypto-util.js";

/**
 * Normalized claims extracted from a CPU TEE quote, regardless of the underlying
 * verifier (dev mock HMAC, or production TDX / SEV-SNP).
 */
export interface QuoteClaims {
  v: 1;
  kind: "tdx" | "sev-snp";
  ed25519_public: string;
  tls_client_cert_sha256: string;
  engine: { version: string; binary_sha256: string };
  vllm: { version: string; binary_sha256: string };
  issued_at: string;
}

/** @deprecated Use {@link QuoteClaims}; retained for the mock quote builder. */
export type MockCpuQuotePayload = QuoteClaims;

export interface AttestationPolicy {
  policyId: string;
  allowedEngineBinarySha256: ReadonlySet<string>;
  allowedVllmBinarySha256: ReadonlySet<string>;
  maxQuoteAgeMs: number;
}

export interface AttestationVerifyResult {
  ok: boolean;
  policyId: string;
  reason?: string;
}

/** Test / dev policy matching `mock-keys.ts` fixtures. */
export const DEFAULT_TEST_ATTESTATION_POLICY: AttestationPolicy = {
  policyId: "teechat-cpu-tee-v1",
  allowedEngineBinarySha256: new Set([
    "a1b2c3d4e5f6789012345678abcdef9012345678abcdef9012345678abcdef90",
  ]),
  allowedVllmBinarySha256: new Set([
    "b2c3d4e5f6789012345678abcdef9012345678abcdef9012345678abcdef9012",
  ]),
  maxQuoteAgeMs: 24 * 60 * 60 * 1000,
};

const MOCK_ATTEST_HMAC_SECRET = Buffer.from("teechat-mock-ope-attest-v1", "utf8");

export function buildMockCpuQuote(payload: MockCpuQuotePayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const mac = createHmac("sha256", MOCK_ATTEST_HMAC_SECRET).update(body).digest();
  return bytesToBase64Url(Buffer.concat([body, mac]));
}

export function parseMockCpuQuote(quote: string): MockCpuQuotePayload | null {
  try {
    const raw = Buffer.from(quote, "base64url");
    if (raw.length < 32 + 1) return null;
    const body = raw.subarray(0, raw.length - 32);
    const mac = raw.subarray(raw.length - 32);
    const expected = createHmac("sha256", MOCK_ATTEST_HMAC_SECRET).update(body).digest();
    if (!timingSafeEqual(mac, expected)) return null;
    return JSON.parse(body.toString("utf8")) as MockCpuQuotePayload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CPU quote verifier seam (dev mock vs production).
// ---------------------------------------------------------------------------

/** Extracts and cryptographically validates claims from a CPU TEE quote. */
export interface CpuQuoteVerifier {
  readonly kind: "mock" | "production";
  /** Returns normalized claims, or `null` if the quote is invalid/unverifiable. */
  extractClaims(quote: string, expectedKind: "tdx" | "sev-snp"): QuoteClaims | null;
}

/** Development verifier: validates the HMAC mock quote. Never use in production. */
export class MockCpuQuoteVerifier implements CpuQuoteVerifier {
  readonly kind = "mock" as const;
  extractClaims(quote: string): QuoteClaims | null {
    return parseMockCpuQuote(quote);
  }
}

/**
 * Production backend hook: a real TDX / SEV-SNP verifier (e.g. wired to OPE
 * `ope-attest`, Intel PCS/TDX QvL, or AMD SEV-SNP roots). It must verify the quote
 * signature, TCB, and measurement chain, and return the normalized claims (or `null`).
 */
export type ProductionQuoteBackend = (
  quote: string,
  expectedKind: "tdx" | "sev-snp",
) => QuoteClaims | null;

let productionBackend: ProductionQuoteBackend | null = null;

/** Register the real CPU-quote verification backend used in production builds. */
export function registerProductionQuoteBackend(backend: ProductionQuoteBackend): void {
  productionBackend = backend;
}

/** Test/runtime hook: remove any registered production backend. */
export function clearProductionQuoteBackend(): void {
  productionBackend = null;
}

/**
 * Production verifier: delegates to the registered backend and **fails closed** when
 * none is configured (no silent fallback to mock).
 */
export class ProductionCpuQuoteVerifier implements CpuQuoteVerifier {
  readonly kind = "production" as const;
  constructor(private readonly backend: ProductionQuoteBackend | null = productionBackend) {}
  extractClaims(quote: string, expectedKind: "tdx" | "sev-snp"): QuoteClaims | null {
    if (!this.backend) {
      throw new Error(
        "production attestation backend not configured; call registerProductionQuoteBackend()",
      );
    }
    return this.backend(quote, expectedKind);
  }
}

/** Pick the CPU-quote verifier for the current build mode (mock in dev, production otherwise). */
export function resolveCpuQuoteVerifier(env: NodeJS.ProcessEnv = process.env): CpuQuoteVerifier {
  return mockAllowed(env) ? new MockCpuQuoteVerifier() : new ProductionCpuQuoteVerifier();
}

export function verifyAttestationBundle(
  bundle: AttestationBundle,
  policy: AttestationPolicy,
  bind: { ed25519Public: string; tlsClientCertSha256: string },
  nowMs = Date.now(),
  verifier: CpuQuoteVerifier = resolveCpuQuoteVerifier(),
): AttestationVerifyResult {
  let payload: QuoteClaims | null;
  try {
    payload = verifier.extractClaims(bundle.cpu_tee.quote, bundle.cpu_tee.kind);
  } catch (e) {
    return {
      ok: false,
      policyId: policy.policyId,
      reason: `attestation_backend_error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!payload) {
    return { ok: false, policyId: policy.policyId, reason: "invalid_cpu_quote" };
  }
  if (payload.v !== 1) {
    return { ok: false, policyId: policy.policyId, reason: "unsupported_quote_version" };
  }
  if (payload.ed25519_public !== bind.ed25519Public) {
    return { ok: false, policyId: policy.policyId, reason: "ed25519_mismatch" };
  }
  if (payload.tls_client_cert_sha256.toLowerCase() !== bind.tlsClientCertSha256.toLowerCase()) {
    return { ok: false, policyId: policy.policyId, reason: "tls_cert_mismatch" };
  }
  const issued = Date.parse(payload.issued_at);
  if (Number.isNaN(issued) || nowMs - issued > policy.maxQuoteAgeMs) {
    return { ok: false, policyId: policy.policyId, reason: "quote_stale" };
  }
  if (!policy.allowedEngineBinarySha256.has(payload.engine.binary_sha256)) {
    return { ok: false, policyId: policy.policyId, reason: "engine_hash_not_allowed" };
  }
  if (!policy.allowedVllmBinarySha256.has(payload.vllm.binary_sha256)) {
    return { ok: false, policyId: policy.policyId, reason: "vllm_hash_not_allowed" };
  }
  if (bundle.engine.binary_sha256 !== payload.engine.binary_sha256) {
    return { ok: false, policyId: policy.policyId, reason: "engine_hash_bundle_mismatch" };
  }
  if (bundle.vllm.binary_sha256 !== payload.vllm.binary_sha256) {
    return { ok: false, policyId: policy.policyId, reason: "vllm_hash_bundle_mismatch" };
  }
  if (bundle.cpu_tee.verdict !== "pass" || bundle.gpu_tee.verdict !== "pass") {
    return { ok: false, policyId: policy.policyId, reason: "verdict_not_pass" };
  }
  return { ok: true, policyId: policy.policyId };
}

export function verifyRegisterAttestation(
  req: EngineRegisterRequest,
  clientCertSha256: string,
  policy: AttestationPolicy = DEFAULT_TEST_ATTESTATION_POLICY,
): AttestationVerifyResult {
  const tls =
    req.tls_client_cert_sha256?.toLowerCase() ?? clientCertSha256.toLowerCase();
  return verifyAttestationBundle(
    req.attestation,
    policy,
    { ed25519Public: req.identity.ed25519_public, tlsClientCertSha256: tls },
  );
}
