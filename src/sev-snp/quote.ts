import { createHash } from "node:crypto";

import { bytesToBase64Url } from "../crypto-util.js";
import type { QuoteClaims } from "../attestation.js";

/** TeeChat SEV-SNP quote wrapper (v2) — `cpu_tee.quote` is base64url(JSON). */
export interface SevSnpQuoteWrapper {
  v: 2;
  kind: "sev-snp";
  /** Raw AMD SNP attestation report (base64). */
  report_b64: string;
  /** 64-byte REPORT_DATA bound into the report (base64). */
  report_data_b64: string;
  claims: QuoteClaims;
}

export function bindReportData64(args: {
  ed25519Public: string;
  tlsClientCertSha256: string;
  engineBinarySha256: string;
  vllmBinarySha256: string;
  issuedAt: string;
  nonce?: string;
}): Buffer {
  const canonical = [
    "teechat-sev-snp-bind-v1",
    args.ed25519Public,
    args.tlsClientCertSha256.toLowerCase(),
    args.engineBinarySha256.toLowerCase(),
    args.vllmBinarySha256.toLowerCase(),
    args.issuedAt,
    args.nonce ?? "",
  ].join("\0");
  return createHash("sha512").update(canonical, "utf8").digest();
}

export function encodeSevSnpQuoteWrapper(wrapper: SevSnpQuoteWrapper): string {
  return bytesToBase64Url(Buffer.from(JSON.stringify(wrapper), "utf8"));
}

export function parseSevSnpQuoteWrapper(quote: string): SevSnpQuoteWrapper | null {
  try {
    const raw = Buffer.from(quote, "base64url");
    const parsed = JSON.parse(raw.toString("utf8")) as SevSnpQuoteWrapper;
    if (parsed?.v !== 2 || parsed.kind !== "sev-snp") return null;
    if (!parsed.report_b64 || !parsed.report_data_b64 || !parsed.claims) return null;
    if (parsed.claims.kind !== "sev-snp") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function verifyWrapperReportData(
  wrapper: SevSnpQuoteWrapper,
  opts: { nonce?: string } = {},
): boolean {
  const data = Buffer.from(wrapper.report_data_b64, "base64");
  if (data.length !== 64) return false;
  const expected = bindReportData64({
    ed25519Public: wrapper.claims.ed25519_public,
    tlsClientCertSha256: wrapper.claims.tls_client_cert_sha256,
    engineBinarySha256: wrapper.claims.engine.binary_sha256,
    vllmBinarySha256: wrapper.claims.vllm.binary_sha256,
    issuedAt: wrapper.claims.issued_at,
    nonce: opts.nonce,
  });
  return timingSafeEqualBuf(data, expected);
}

function timingSafeEqualBuf(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
