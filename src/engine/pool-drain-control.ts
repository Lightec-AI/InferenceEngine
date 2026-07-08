/**
 * Runtime pool drain control — SIGUSR2 + JSON request file (no engine process restart).
 * Used by blue slot during in-place engine blue/green cutover.
 *
 * Request file accepts either:
 *   { "fraction": 0.5 }  — legacy half/full (fraction of fleet N)
 *   { "count": 1 }       — paired one-by-one / batch-K idle drain
 */

import { readFileSync, unlinkSync } from "node:fs";

import type { SupervisedEnginePlanePool } from "./supervised-pool.js";
import { parsePoolDrainRequestJson, type PoolDrainRequest } from "./pool-cutover.js";
import { logEnginePoolDrain } from "../ops/engine-events.js";

export interface EnginePoolDrainControlOptions {
  pool: SupervisedEnginePlanePool;
  engineId: string;
  requestFile?: string;
  onDrained?: (
    result: Awaited<ReturnType<SupervisedEnginePlanePool["drainIdlePool"]>>,
  ) => void;
}

export function readPoolDrainRequestFile(path: string): PoolDrainRequest {
  const raw = readFileSync(path, "utf8");
  return parsePoolDrainRequestJson(raw);
}

function defaultPoolDrainRequestFile(): string {
  const fromEnv = process.env.TEECHAT_ENGINE_POOL_DRAIN_FILE?.trim();
  if (fromEnv) return fromEnv;
  const slot = process.env.TEECHAT_ENGINE_SLOT?.trim();
  if (slot === "blue" || slot === "green") {
    return `/etc/teechat/engine-pool-drain-${slot}.json`;
  }
  return "/etc/teechat/engine-pool-drain.json";
}

export function installEnginePoolDrainControl(opts: EnginePoolDrainControlOptions): void {
  const requestFile = opts.requestFile?.trim() || defaultPoolDrainRequestFile();

  let handling = false;

  const runDrain = async (): Promise<void> => {
    if (handling) return;
    handling = true;
    try {
      const req = readPoolDrainRequestFile(requestFile);
      const result =
        req.count !== undefined
          ? await opts.pool.drainIdleSessions(req.count)
          : await opts.pool.drainIdlePool(req.fraction!);
      logEnginePoolDrain(opts.engineId, result.drained, result.remaining, result.blocked);
      opts.onDrained?.(result);
      try {
        unlinkSync(requestFile);
      } catch {
        /* best-effort */
      }
    } catch (e) {
      console.error(
        `[engine-pool-drain] failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      handling = false;
    }
  };

  process.on("SIGUSR2", () => {
    void runDrain();
  });
}
