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
  /**
   * Fraction of N to drain this step (0..1).
   * Ignored when `count` is set — fraction-of-N cannot step mid-migrate
   * (after blue holds below N, fraction=1/N wants targetRemaining=N-1 and drains 0).
   */
  fraction?: number;
  /**
   * Exact idle sessions to drain this step (paired one-by-one cutover).
   * Prefer this over `fraction` during gradual migration.
   */
  count?: number;
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
  /** Fraction-of-N drain (legacy half/full). Mutually exclusive with `count`. */
  fraction?: number;
  /** Drain exactly this many idle sessions (paired stepper). */
  count?: number;
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

/**
 * Plan an exact idle-session drain (paired one-by-one / batch-K cutover).
 * Unlike fraction-of-N, this works at any mid-migrate `currentCount`.
 */
export function planPoolDrainByCount(input: {
  currentCount: number;
  count: number;
  idleCount: number;
}): PoolDrainPlan {
  const { currentCount, count, idleCount } = input;
  if (currentCount < 1) {
    return { targetRemaining: 0, toDrain: 0, blocked: false };
  }
  if (!Number.isInteger(count) || count < 1) {
    return {
      targetRemaining: currentCount,
      toDrain: 0,
      blocked: true,
      reason: "invalid_count",
    };
  }
  const wantDrain = Math.min(count, currentCount);
  const toDrain = Math.min(wantDrain, idleCount);
  const blocked = toDrain < wantDrain;
  return {
    targetRemaining: currentCount - toDrain,
    toDrain,
    blocked,
    reason: blocked ? "insufficient_idle_sessions" : undefined,
  };
}

export function planPoolDrain(input: PoolDrainPlanInput): PoolDrainPlan {
  const { poolTargetSize, currentCount, fraction, count, idleCount } = input;
  if (count !== undefined) {
    return planPoolDrainByCount({ currentCount, count, idleCount });
  }
  if (currentCount < 1) {
    return { targetRemaining: 0, toDrain: 0, blocked: false };
  }
  if (poolTargetSize < 1) {
    return { targetRemaining: currentCount, toDrain: 0, blocked: true, reason: "pool_size_zero" };
  }
  if (fraction === undefined || fraction < 0 || fraction > 1) {
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
  const parsed = JSON.parse(raw) as Partial<PoolDrainRequest> & { count?: number };
  const hasCount = parsed.count !== undefined && parsed.count !== null;
  const hasFraction = parsed.fraction !== undefined && parsed.fraction !== null;
  if (hasCount) {
    const count = Number(parsed.count);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error("pool drain: count must be a positive integer");
    }
    return { count };
  }
  if (!hasFraction) {
    throw new Error("pool drain: require fraction (0..1) or count (>=1)");
  }
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

/** Default max in-flight attested connects (boot / scale / migrate / reconnect). */
export const DEFAULT_POOL_CONNECT_CONCURRENCY = 2;

/** Default delay between starting new attested connects (ms). */
export const DEFAULT_POOL_CONNECT_STAGGER_MS = 150;

/**
 * Max in-flight attested connects during pool boot/scale/migrate/reconnect.
 * Unset → {@link DEFAULT_POOL_CONNECT_CONCURRENCY} (avoids gateway event-loop starvation).
 * `0` or `unlimited` → open up to sessionCount in parallel (break-glass).
 */
export function poolConnectConcurrencyFromEnv(
  env: NodeJS.ProcessEnv,
  sessionCount: number,
): number {
  if (sessionCount < 1) return 1;
  const raw = env.TEECHAT_ENGINE_POOL_CONNECT_CONCURRENCY?.trim().toLowerCase();
  if (raw === "0" || raw === "unlimited") return sessionCount;
  if (!raw) return Math.min(DEFAULT_POOL_CONNECT_CONCURRENCY, sessionCount);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return Math.min(DEFAULT_POOL_CONNECT_CONCURRENCY, sessionCount);
  return Math.min(Math.floor(n), sessionCount);
}

/**
 * Minimum spacing between *starting* new attested connects (ms).
 * Unset → {@link DEFAULT_POOL_CONNECT_STAGGER_MS}. `0` disables.
 */
export function poolConnectStaggerMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TEECHAT_ENGINE_POOL_CONNECT_STAGGER_MS?.trim();
  if (!raw) return DEFAULT_POOL_CONNECT_STAGGER_MS;
  if (raw === "0") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_POOL_CONNECT_STAGGER_MS;
  return Math.floor(n);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Limits concurrent attested connects and spaces start times.
 * Shared across boot, scale, migrate, and reconnect so a burst cannot wedge the gateway.
 */
export class PoolConnectThrottle {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private nextStartAt = 0;

  constructor(
    readonly concurrency: number,
    readonly staggerMs: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const now = Date.now();
      const wait = Math.max(0, this.nextStartAt - now);
      this.nextStartAt = Math.max(this.nextStartAt, now) + this.staggerMs;
      if (wait > 0) await sleepMs(wait);
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.concurrency) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.inFlight += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export function createPoolConnectThrottleFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  sessionCountHint = 32,
): PoolConnectThrottle {
  return new PoolConnectThrottle(
    poolConnectConcurrencyFromEnv(env, sessionCountHint),
    poolConnectStaggerMsFromEnv(env),
  );
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
