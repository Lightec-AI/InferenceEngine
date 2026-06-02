/**
 * Browser-safe engine trust verification (mock attestation + epoch checks).
 * No Node `crypto` or `ope-ffi` — suitable for web/Capacitor.
 */

import type { AttestationBundle, EngineTrustBundle } from "./protocol/types.js";

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

const MOCK_ATTEST_HMAC_SECRET = new TextEncoder().encode("teechat-mock-ope-attest-v1");

function base64UrlToBytes(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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

async function verifyAttestationBundleBrowser(
  bundle: AttestationBundle,
  policy: BrowserAttestationPolicy,
  bind: { ed25519Public: string; tlsClientCertSha256: string },
  nowMs: number,
  skipTlsCertBinding: boolean,
): Promise<BrowserTrustVerifyResult> {
  const payload = await parseMockCpuQuote(bundle.cpu_tee.quote);
  if (!payload) return { ok: false, reason: "invalid_cpu_quote" };
  if (payload.v !== 1) return { ok: false, reason: "unsupported_quote_version" };
  if (payload.ed25519_public !== bind.ed25519Public) {
    return { ok: false, reason: "ed25519_mismatch" };
  }
  if (
    !skipTlsCertBinding &&
    payload.tls_client_cert_sha256.toLowerCase() !== bind.tlsClientCertSha256.toLowerCase()
  ) {
    return { ok: false, reason: "tls_cert_mismatch" };
  }
  const issued = Date.parse(payload.issued_at);
  if (Number.isNaN(issued) || nowMs - issued > policy.maxQuoteAgeMs) {
    return { ok: false, reason: "quote_stale" };
  }
  if (!policy.allowedEngineBinarySha256.has(payload.engine.binary_sha256)) {
    return { ok: false, reason: "engine_hash_not_allowed" };
  }
  if (!policy.allowedVllmBinarySha256.has(payload.vllm.binary_sha256)) {
    return { ok: false, reason: "vllm_hash_not_allowed" };
  }
  if (bundle.engine.binary_sha256 !== payload.engine.binary_sha256) {
    return { ok: false, reason: "engine_hash_bundle_mismatch" };
  }
  if (bundle.vllm.binary_sha256 !== payload.vllm.binary_sha256) {
    return { ok: false, reason: "vllm_hash_bundle_mismatch" };
  }
  if (bundle.cpu_tee.verdict !== "pass" || bundle.gpu_tee.verdict !== "pass") {
    return { ok: false, reason: "verdict_not_pass" };
  }
  return { ok: true };
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
}

/** Client-side trust bundle verification for browsers (dev mock attestation). */
export async function verifyEngineTrustBundleBrowser(
  bundle: EngineTrustBundle,
  policy: BrowserAttestationPolicy,
  tlsClientCertSha256: string,
  nowMs = Date.now(),
  opts: VerifyEngineTrustBundleBrowserOptions = {},
): Promise<BrowserTrustVerifyResult> {
  const attest = await verifyAttestationBundleBrowser(
    bundle.attestation,
    policy,
    {
      ed25519Public: bundle.identity.ed25519_public,
      tlsClientCertSha256,
    },
    nowMs,
    opts.skipTlsCertBinding ?? false,
  );
  if (!attest.ok) return attest;

  if (!isEpochActive(bundle.not_before, bundle.not_after, nowMs)) {
    return { ok: false, reason: "epoch_expired" };
  }

  const sigOk = await verifyEphemeralIdentitySignatureBrowser(
    bundle.identity.ed25519_public,
    bundle,
  );
  if (!sigOk) return { ok: false, reason: "invalid_identity_signature" };

  return { ok: true };
}

export type { EngineTrustBundle };
