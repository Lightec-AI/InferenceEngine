import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { signUsageReport, usageReportSigningBytes, verifyUsageReport } from "../src/metering.js";
import type { SignedUsageReport, UsageReport } from "../src/protocol/types.js";

function rawEd25519PublicB64Url(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(-32).toString("base64url");
}

describe("usage metering", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const ed25519Public = rawEd25519PublicB64Url(publicKey);

  function signed(report: UsageReport): SignedUsageReport {
    return { report, sig: signUsageReport(privateKey, report) };
  }

  it("verifyUsageReport accepts canonical signed bytes", () => {
    const report: UsageReport = {
      request_id: "req-1",
      conversation_id: "conv-1",
      engine_id: "engine-1",
      prompt_tokens: 100,
      completion_tokens: 20,
      ts: "2026-05-21T00:00:00Z",
    };
    expect(verifyUsageReport(ed25519Public, signed(report))).toBe(true);
    expect(verifyUsageReport(ed25519Public, { report, sig: Buffer.alloc(64).toString("base64url") })).toBe(
      false,
    );
  });

  it("usageReportSigningBytes is stable for key order", () => {
    const report: UsageReport = {
      request_id: "r",
      conversation_id: "c",
      engine_id: "e",
      prompt_tokens: 1,
      completion_tokens: 2,
      ts: "t",
    };
    const bytes = usageReportSigningBytes(report);
    expect(bytes.toString("utf8")).toContain('"completion_tokens":2');
    expect(sign(null, bytes, privateKey).length).toBe(64);
  });
});
