/**
 * Ephemeral epoch rotation scheduling (T-4).
 */

import { epochRotationPolicyFromEnv, type EpochRotationPolicy } from "./supervisor.js";

export function epochRotationLeadMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const leadMin = Number(env.TEECHAT_OPE_EPOCH_ROTATION_LEAD_MIN ?? "60") || 60;
  return Math.max(1, leadMin) * 60 * 1000;
}

/** When to schedule the next rotation (ms since epoch) — rotate before not_after expires. */
export function computeEpochRotateAtMs(notAfterIso: string, leadMs: number, nowMs = Date.now()): number {
  const notAfterMs = Date.parse(notAfterIso);
  if (Number.isNaN(notAfterMs)) return nowMs;
  return Math.max(nowMs, notAfterMs - leadMs);
}

export function epochTtlMsFromPolicy(policy: EpochRotationPolicy = epochRotationPolicyFromEnv()): number {
  return policy.rotationIntervalMs;
}

export { epochRotationPolicyFromEnv, type EpochRotationPolicy };
