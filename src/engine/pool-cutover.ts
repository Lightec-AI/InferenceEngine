/**
 * Plan idle-first engine pool drain/scale for in-place blue/green cutover.
 * Total live gateway sessions for an engine_id stay ≤ poolTargetSize when ops
 * run paired green scale + blue drain steps.
 */

export interface PoolDrainPlanInput {
  /** Declared fleet pool size (N). */
  poolTargetSize: number;
  /** Live sessions in this process. */
  currentCount: number;
  /** Fraction of N to drain this step (0..1). */
  fraction: number;
  /** Idle (non-busy) sessions available to drain. */
  idleCount: number;
}

export interface PoolDrainPlan {
  targetRemaining: number;
  toDrain: number;
  blocked: boolean;
  reason?: string;
}

export interface PoolScalePlanInput {
  poolTargetSize: number;
  currentCount: number;
  targetSize: number;
}

export interface PoolScalePlan {
  targetSize: number;
  toAdd: number;
  blocked: boolean;
  reason?: string;
}

export interface PoolDrainRequest {
  fraction: number;
}

export interface PoolScaleRequest {
  target_size: number;
}

/** Sessions to open on supervised pool boot when staging green at half capacity. */
export function initialPoolSessionCount(poolTargetSize: number, fraction: number): number {
  if (poolTargetSize < 1) return 0;
  if (fraction <= 0) return 0;
  if (fraction >= 1) return poolTargetSize;
  return Math.max(1, Math.floor(poolTargetSize * fraction));
}

export function planPoolDrain(input: PoolDrainPlanInput): PoolDrainPlan {
  const { poolTargetSize, currentCount, fraction, idleCount } = input;
  if (currentCount < 1) {
    return { targetRemaining: 0, toDrain: 0, blocked: false };
  }
  if (poolTargetSize < 1) {
    return { targetRemaining: currentCount, toDrain: 0, blocked: true, reason: "pool_size_zero" };
  }
  if (fraction < 0 || fraction > 1) {
    return { targetRemaining: currentCount, toDrain: 0, blocked: true, reason: "invalid_fraction" };
  }

  const targetRemaining = Math.floor(poolTargetSize * (1 - fraction));
  const wantDrain = Math.max(0, currentCount - targetRemaining);
  if (wantDrain === 0) {
    return { targetRemaining: currentCount, toDrain: 0, blocked: false };
  }
  const toDrain = Math.min(wantDrain, idleCount);
  const blocked = toDrain < wantDrain;
  return {
    targetRemaining: currentCount - toDrain,
    toDrain,
    blocked,
    reason: blocked ? "insufficient_idle_sessions" : undefined,
  };
}

export function planPoolScale(input: PoolScalePlanInput): PoolScalePlan {
  const { poolTargetSize, currentCount, targetSize } = input;
  if (poolTargetSize < 1) {
    return { targetSize, toAdd: 0, blocked: true, reason: "pool_size_zero" };
  }
  if (!Number.isInteger(targetSize) || targetSize < 1 || targetSize > poolTargetSize) {
    return { targetSize, toAdd: 0, blocked: true, reason: "invalid_target_size" };
  }
  const toAdd = Math.max(0, targetSize - currentCount);
  return { targetSize, toAdd, blocked: false };
}

export function parsePoolDrainRequestJson(raw: string): PoolDrainRequest {
  const parsed = JSON.parse(raw) as Partial<PoolDrainRequest>;
  const fraction = Number(parsed.fraction);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error("pool drain: fraction must be 0..1");
  }
  return { fraction };
}

export function parsePoolScaleRequestJson(raw: string): PoolScaleRequest {
  const parsed = JSON.parse(raw) as Partial<PoolScaleRequest> & { targetSize?: number };
  const targetSize = Number(parsed.target_size ?? parsed.targetSize);
  if (!Number.isInteger(targetSize) || targetSize < 1) {
    throw new Error("pool scale: target_size must be a positive integer");
  }
  return { target_size: targetSize };
}

export function poolInitialFractionFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TEECHAT_ENGINE_POOL_INITIAL_FRACTION?.trim();
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return 1;
  return n;
}

/**
 * Max in-flight attested connects during pool boot/scale.
 * Unset or 0 = open all sessions in parallel (capped by sessionCount).
 */
export function poolConnectConcurrencyFromEnv(
  env: NodeJS.ProcessEnv,
  sessionCount: number,
): number {
  if (sessionCount < 1) return 1;
  const raw = env.TEECHAT_ENGINE_POOL_CONNECT_CONCURRENCY?.trim();
  if (!raw || raw === "0") return sessionCount;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return sessionCount;
  return Math.min(Math.floor(n), sessionCount);
}

/** Run `count` tasks with at most `concurrency` in flight (preserves result order). */
export async function mapWithConcurrency<T>(
  count: number,
  concurrency: number,
  fn: (index: number) => Promise<T>,
): Promise<T[]> {
  if (count < 1) return [];
  const limit = Math.max(1, Math.min(concurrency, count));
  const results: T[] = new Array(count);
  let next = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) break;
      results[index] = await fn(index);
    }
  });
  await Promise.all(workers);
  return results;
}
