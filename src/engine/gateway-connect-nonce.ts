import { randomBytes } from "node:crypto";

import { parseMockCpuQuote } from "../attestation.js";
import type { AttestationBundle } from "../protocol/types.js";
import { parseSevSnpQuoteWrapper, verifyWrapperReportData } from "../sev-snp/quote.js";

const NONCE_RE = /^[a-f0-9]{32}$/;

/** 128-bit hex challenge for engine-plane gateway mutual attestation (connect batch). */
export function generateGatewayConnectChallengeNonce(): string {
  return randomBytes(16).toString("hex");
}

export function isValidGatewayConnectChallengeNonce(value: string): boolean {
  return NONCE_RE.test(value.trim().toLowerCase());
}

export function normalizeGatewayConnectChallengeNonce(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  return isValidGatewayConnectChallengeNonce(normalized) ? normalized : undefined;
}

/** Confirm gateway quote binds the engine-issued connect challenge (mock TDX or SEV-SNP). */
export function verifyGatewayConnectChallengeInBundle(
  bundle: AttestationBundle,
  expectedNonce: string,
): boolean {
  const nonce = expectedNonce.trim().toLowerCase();
  if (!isValidGatewayConnectChallengeNonce(nonce)) return false;

  const quote = bundle.cpu_tee.quote;
  if (bundle.cpu_tee.kind === "sev-snp") {
    const wrapper = parseSevSnpQuoteWrapper(quote);
    if (!wrapper) return false;
    return verifyWrapperReportData(wrapper, { nonce });
  }

  const payload = parseMockCpuQuote(quote);
  if (!payload) return false;
  const bound = (payload as QuoteClaimsWithNonce).nonce;
  return typeof bound === "string" && bound.toLowerCase() === nonce;
}

interface QuoteClaimsWithNonce {
  nonce?: string;
}
