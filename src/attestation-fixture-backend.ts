import type { ProductionQuoteBackend, QuoteClaims } from "./attestation.js";
import { parseMockCpuQuote } from "./attestation.js";

/**
 * Pre-hardware production backend: accepts only HMAC mock quotes that match
 * known test fixtures (same bytes as dev mock). Replace with real TDX verify after rent.
 */
export const FIXTURE_INTEL_TDX_QUOTE_PLACEHOLDER =
  "fixture-intel-tdx-v1-not-real-hardware";

export function createFixtureProductionQuoteBackend(
  allowedQuotes: ReadonlySet<string> = new Set([FIXTURE_INTEL_TDX_QUOTE_PLACEHOLDER]),
): ProductionQuoteBackend {
  return (quote: string, expectedKind: "tdx" | "sev-snp") => {
    if (!allowedQuotes.has(quote)) {
      const claims = parseMockCpuQuote(quote);
      if (claims && claims.kind === expectedKind) return claims;
      return null;
    }
    if (expectedKind !== "tdx") return null;
    return {
      v: 1,
      kind: "tdx",
      ed25519_public: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tls_client_cert_sha256: "",
      engine: {
        version: "fixture",
        binary_sha256: "a1b2c3d4e5f6789012345678abcdef9012345678abcdef9012345678abcdef90",
      },
      vllm: {
        version: "fixture",
        binary_sha256: "b2c3d4e5f6789012345678abcdef9012345678abcdef9012345678abcdef9012",
      },
      issued_at: new Date().toISOString(),
    } satisfies QuoteClaims;
  };
}
