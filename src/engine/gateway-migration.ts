/**
 * Plan idle-first gateway plane migration (Phase 2 blue/green).
 * Total pool size stays fixed; sessions move make-before-break to targetUrl.
 */

export interface GatewayMigrationPlanInput {
  poolSize: number;
  onTarget: number;
  fraction: number;
  idleOnSource: number;
}

export interface GatewayMigrationPlan {
  targetCount: number;
  toMove: number;
  blocked: boolean;
  reason?: string;
}

export function planGatewayMigration(input: GatewayMigrationPlanInput): GatewayMigrationPlan {
  const { poolSize, onTarget, fraction, idleOnSource } = input;
  if (poolSize < 1) {
    return { targetCount: 0, toMove: 0, blocked: true, reason: "pool_size_zero" };
  }
  if (fraction < 0 || fraction > 1) {
    return { targetCount: 0, toMove: 0, blocked: true, reason: "invalid_fraction" };
  }

  const targetCount = Math.floor(poolSize * fraction);
  const need = Math.max(0, targetCount - onTarget);
  if (need === 0) {
    return { targetCount, toMove: 0, blocked: false };
  }
  if (idleOnSource < need) {
    return {
      targetCount,
      toMove: idleOnSource,
      blocked: true,
      reason: "insufficient_idle_sessions",
    };
  }
  return { targetCount, toMove: need, blocked: false };
}

export interface GatewayMigrationRequest {
  target_url: string;
  fraction: number;
}

export function parseGatewayMigrationRequestJson(raw: string): GatewayMigrationRequest {
  const parsed = JSON.parse(raw) as Partial<GatewayMigrationRequest>;
  const target = parsed.target_url?.trim();
  const fraction = Number(parsed.fraction);
  if (!target) throw new Error("gateway migration: target_url required");
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error("gateway migration: fraction must be 0..1");
  }
  return { target_url: target, fraction };
}
