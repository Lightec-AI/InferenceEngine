import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function sevSnpGuestBinFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.TEECHAT_SNP_GUEST_BIN ?? "snpguest").trim() || "snpguest";
}

export function isSevSnpGuestDeviceAvailable(): boolean {
  return existsSync("/dev/sev-guest");
}

export function isSevSnpGuestToolAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const bin = sevSnpGuestBinFromEnv(env);
  try {
    execFileSync(bin, ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function shouldUseSevSnpAttestation(env: NodeJS.ProcessEnv = process.env): boolean {
  const kind = (env.TEECHAT_CPU_TEE_KIND ?? "").trim().toLowerCase();
  if (kind === "sev-snp" || kind === "snp") return true;
  if (kind === "fixture" || kind === "mock" || kind === "tdx") return false;
  return isSevSnpGuestDeviceAvailable() && isSevSnpGuestToolAvailable(env);
}

/** Request an AMD SNP attestation report with 64-byte REPORT_DATA bound into the report. */
export function requestSevSnpAttestationReport(
  reportData64: Buffer,
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  if (reportData64.length !== 64) {
    throw new Error("SEV-SNP report_data must be exactly 64 bytes");
  }
  if (!isSevSnpGuestDeviceAvailable()) {
    throw new Error("/dev/sev-guest is not available — install linux-modules-extra and modprobe sev-guest");
  }
  const bin = sevSnpGuestBinFromEnv(env);
  const dir = mkdtempSync(join(tmpdir(), "teechat-snp-report-"));
  try {
    const reqPath = join(dir, "request.bin");
    const reportPath = join(dir, "report.bin");
    writeFileSync(reqPath, reportData64);
    execFileSync(bin, ["report", reportPath, reqPath], { stdio: "pipe", env: process.env });
    return readFileSync(reportPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
