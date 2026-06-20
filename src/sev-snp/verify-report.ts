import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sevSnpGuestBinFromEnv } from "./guest-report.js";

const REPORT_DATA_OFFSET = 0x50;
const REPORT_DATA_LEN = 64;

/** Extract REPORT_DATA from a raw AMD SNP attestation report (little-endian layout). */
export function extractReportDataFromReport(report: Buffer): Buffer | null {
  if (report.length < REPORT_DATA_OFFSET + REPORT_DATA_LEN) return null;
  return report.subarray(REPORT_DATA_OFFSET, REPORT_DATA_OFFSET + REPORT_DATA_LEN);
}

function snpCertCacheDir(env: NodeJS.ProcessEnv): string {
  return (env.TEECHAT_SNP_CERT_CACHE_DIR ?? "/var/cache/teechat/snp-certs").trim();
}

function snpCpuFamily(env: NodeJS.ProcessEnv): string {
  return (env.TEECHAT_SNP_CPU_FAMILY ?? "milan").trim().toLowerCase() || "milan";
}

function ensureSnpCertificates(reportPath: string, env: NodeJS.ProcessEnv): string {
  const cache = snpCertCacheDir(env);
  mkdirSync(cache, { recursive: true });
  const bin = sevSnpGuestBinFromEnv(env);
  const family = snpCpuFamily(env);
  const vcek = join(cache, "vcek.pem");
  if (!existsSync(vcek)) {
    execFileSync(bin, ["fetch", "vcek", "pem", cache, reportPath], {
      stdio: "pipe",
      env: process.env,
    });
  }
  const ark = join(cache, "ark.pem");
  if (!existsSync(ark)) {
    execFileSync(bin, ["fetch", "ca", "pem", cache, family], { stdio: "pipe", env: process.env });
  }
  return cache;
}

/** Verify AMD SNP report signature against AMD VCEK/CA chain via snpguest. */
export function verifySevSnpAttestationReport(
  report: Buffer,
  expectedReportData: Buffer,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (expectedReportData.length !== 64) return false;
  const embedded = extractReportDataFromReport(report);
  if (!embedded || !embedded.equals(expectedReportData)) return false;

  const bin = sevSnpGuestBinFromEnv(env);
  const dir = mkdtempSync(join(tmpdir(), "teechat-snp-verify-"));
  try {
    const reportPath = join(dir, "report.bin");
    writeFileSync(reportPath, report);
    const certs = ensureSnpCertificates(reportPath, env);
    execFileSync(bin, ["verify", "certs", certs], { stdio: "pipe", env: process.env });
    const out = execFileSync(bin, ["verify", "attestation", certs, reportPath], {
      stdio: "pipe",
      env: process.env,
    });
    return out.toString("utf8").includes("VEK signed the Attestation Report");
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
