import type { ProductionQuoteBackend } from "./attestation.js";
import { parseSevSnpQuoteWrapper, verifyWrapperReportData } from "./sev-snp/quote.js";
import { verifySevSnpAttestationReport } from "./sev-snp/verify-report.js";

export interface SevSnpQuoteBackendOptions {
  env?: NodeJS.ProcessEnv;
  /** Optional nonce for platform attestation quotes that bind client challenge. */
  nonce?: string;
}

/** Production CPU quote backend: AMD SEV-SNP via snpguest verify + REPORT_DATA binding. */
export function createSevSnpProductionQuoteBackend(
  opts: SevSnpQuoteBackendOptions = {},
): ProductionQuoteBackend {
  const env = opts.env ?? process.env;
  return (quote: string, expectedKind: "tdx" | "sev-snp") => {
    if (expectedKind !== "sev-snp") return null;
    const wrapper = parseSevSnpQuoteWrapper(quote);
    if (!wrapper) return null;
    if (!verifyWrapperReportData(wrapper, { nonce: opts.nonce })) return null;

    const report = Buffer.from(wrapper.report_b64, "base64");
    const reportData = Buffer.from(wrapper.report_data_b64, "base64");
    if (!verifySevSnpAttestationReport(report, reportData, env)) return null;

    return wrapper.claims;
  };
}
