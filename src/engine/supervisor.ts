/**
 * Engine process supervisor (E-2): health ticks, epoch rotation hints, graceful shutdown.
 */

export interface EpochRotationPolicy {
  rotationIntervalMs: number;
  overlapGraceMs: number;
}

export function epochRotationPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): EpochRotationPolicy {
  const rotationHours = Number(env.TEECHAT_OPE_EPOCH_ROTATION_HOURS ?? "24") || 24;
  const overlapMinutes = Number(env.TEECHAT_OPE_EPOCH_OVERLAP_GRACE_MIN ?? "15") || 15;
  return {
    rotationIntervalMs: rotationHours * 60 * 60 * 1000,
    overlapGraceMs: overlapMinutes * 60 * 1000,
  };
}

export interface EngineSupervisorOptions {
  engineId: string;
  policy?: EpochRotationPolicy;
  onSuggestEpochRotation?: (engineId: string) => void;
  onHealthTick?: (engineId: string, healthy: boolean) => void;
}

export interface EngineSupervisor {
  readonly engineId: string;
  markHealthy(): void;
  markUnhealthy(): void;
  isHealthy(): boolean;
  suggestRotationIfDue(startedAtMs: number, nowMs?: number): boolean;
  shutdown(): Promise<void>;
}

export function createEngineSupervisor(opts: EngineSupervisorOptions): EngineSupervisor {
  const policy = opts.policy ?? epochRotationPolicyFromEnv();
  let healthy = false;
  let shuttingDown = false;

  return {
    engineId: opts.engineId,
    markHealthy() {
      healthy = true;
      opts.onHealthTick?.(opts.engineId, true);
    },
    markUnhealthy() {
      healthy = false;
      opts.onHealthTick?.(opts.engineId, false);
    },
    isHealthy() {
      return healthy && !shuttingDown;
    },
    suggestRotationIfDue(startedAtMs: number, nowMs = Date.now()) {
      if (nowMs - startedAtMs >= policy.rotationIntervalMs) {
        opts.onSuggestEpochRotation?.(opts.engineId);
        return true;
      }
      return false;
    },
    async shutdown() {
      shuttingDown = true;
      healthy = false;
    },
  };
}
