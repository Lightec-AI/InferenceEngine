/**
 * Runtime pool scale control — SIGUSR3 + JSON request file (no engine process restart).
 * Used by green slot during in-place engine blue/green cutover completion.
 */

import { readFileSync, unlinkSync } from "node:fs";

import type { SupervisedEnginePlanePool } from "./supervised-pool.js";
import { parsePoolScaleRequestJson } from "./pool-cutover.js";
import { logEnginePoolScale } from "../ops/engine-events.js";

export interface EnginePoolScaleControlOptions {
  pool: SupervisedEnginePlanePool;
  engineId: string;
  requestFile?: string;
  onScaled?: (result: Awaited<ReturnType<SupervisedEnginePlanePool["scalePool"]>>) => void;
}

export function readPoolScaleRequestFile(path: string): { target_size: number } {
  const raw = readFileSync(path, "utf8");
  return parsePoolScaleRequestJson(raw);
}

export function installEnginePoolScaleControl(opts: EnginePoolScaleControlOptions): void {
  const requestFile =
    opts.requestFile?.trim() ||
    process.env.TEECHAT_ENGINE_POOL_SCALE_FILE?.trim() ||
    "/etc/teechat/engine-pool-scale.json";

  let handling = false;

  const runScale = async (): Promise<void> => {
    if (handling) return;
    handling = true;
    try {
      const req = readPoolScaleRequestFile(requestFile);
      const result = await opts.pool.scalePool(req.target_size);
      if (result.added > 0) {
        logEnginePoolScale(opts.engineId, result.added, result.total);
      }
      opts.onScaled?.(result);
      try {
        unlinkSync(requestFile);
      } catch {
        /* best-effort */
      }
    } catch (e) {
      console.error(
        `[engine-pool-scale] failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      handling = false;
    }
  };

  process.on("SIGUSR3" as NodeJS.Signals, () => {
    void runScale();
  });
}
