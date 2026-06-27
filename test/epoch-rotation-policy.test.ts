import { describe, expect, it } from "vitest";

import {
  computeEpochRotateAtMs,
  epochRotationLeadMsFromEnv,
  epochTtlMsFromPolicy,
} from "../src/engine/epoch-rotation-policy.js";

describe("epoch rotation policy", () => {
  it("computes rotate-at as not_after minus lead", () => {
    const notAfter = "2026-06-28T12:00:00.000Z";
    const leadMs = 60 * 60 * 1000;
    const notAfterMs = Date.parse(notAfter);
    expect(computeEpochRotateAtMs(notAfter, leadMs, notAfterMs - 2 * leadMs)).toBe(notAfterMs - leadMs);
  });

  it("never schedules rotation in the past", () => {
    const now = Date.now();
    expect(computeEpochRotateAtMs(new Date(now - 1000).toISOString(), 60_000, now)).toBe(now);
  });

  it("reads lead minutes from env", () => {
    expect(epochRotationLeadMsFromEnv({ TEECHAT_OPE_EPOCH_ROTATION_LEAD_MIN: "30" })).toBe(30 * 60 * 1000);
  });

  it("maps rotation hours to ttl ms", () => {
    expect(epochTtlMsFromPolicy({ rotationIntervalMs: 3_600_000, overlapGraceMs: 0 })).toBe(3_600_000);
  });
});
