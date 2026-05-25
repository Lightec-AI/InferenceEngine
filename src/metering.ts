import { createHash, sign, verify, type KeyObject } from "node:crypto";

import { base64UrlToBytes, ed25519PublicKeyFromBase64Url } from "./crypto-util.js";

import type { SignedUsageReport, UsageReport } from "./protocol/types.js";

/** Canonical JSON bytes for engine usage signatures (sorted keys; gateway billing). */
export function usageReportSigningBytes(report: UsageReport): Buffer {
  const canonical = {
    completion_tokens: report.completion_tokens,
    conversation_id: report.conversation_id,
    engine_id: report.engine_id,
    prompt_tokens: report.prompt_tokens,
    request_id: report.request_id,
    ts: report.ts,
  };
  return Buffer.from(JSON.stringify(canonical), "utf8");
}

export function verifyUsageReport(
  ed25519PublicBase64Url: string,
  signed: SignedUsageReport,
): boolean {
  const msg = usageReportSigningBytes(signed.report);
  const sig = base64UrlToBytes(signed.sig);
  if (sig.length !== 64) return false;
  try {
    const key = ed25519PublicKeyFromBase64Url(ed25519PublicBase64Url);
    return verify(null, msg, key, sig);
  } catch {
    return false;
  }
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function signUsageReport(
  privateKey: KeyObject,
  report: UsageReport,
): string {
  return sign(null, usageReportSigningBytes(report), privateKey).toString("base64url");
}
