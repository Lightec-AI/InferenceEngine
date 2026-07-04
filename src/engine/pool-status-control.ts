/**
 * Publish live pool size for ops cutover gates (engine self-report).
 * Writes a small JSON status file on the engine guest — not exposed via gateway.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { SupervisedEnginePlanePool } from "./supervised-pool.js";

export const ENGINE_POOL_STATUS_SCHEMA = "teechat-engine-pool-status/v1";

export interface EnginePoolStatusSnapshot {
  schema: typeof ENGINE_POOL_STATUS_SCHEMA;
  engine_id: string;
  live_sessions: number;
  updated_at: string;
}

export interface EnginePoolStatusControlOptions {
  pool: Pick<SupervisedEnginePlanePool, "sessionIds">;
  engineId: string;
  statusFile?: string;
  /** Default 1000ms. */
  intervalMs?: number;
}

export function defaultPoolStatusFile(): string {
  const fromEnv = process.env.TEECHAT_ENGINE_POOL_STATUS_FILE?.trim();
  if (fromEnv) return fromEnv;
  const slot = process.env.TEECHAT_ENGINE_SLOT?.trim();
  if (slot === "blue" || slot === "green") {
    return `/etc/teechat/engine-pool-status-${slot}.json`;
  }
  return "/etc/teechat/engine-pool-status.json";
}

export function buildPoolStatusSnapshot(
  engineId: string,
  liveSessions: number,
  now = new Date(),
): EnginePoolStatusSnapshot {
  return {
    schema: ENGINE_POOL_STATUS_SCHEMA,
    engine_id: engineId,
    live_sessions: liveSessions,
    updated_at: now.toISOString(),
  };
}

/** Atomic replace so readers never see a partial write. */
export function writePoolStatusFile(statusFile: string, snapshot: EnginePoolStatusSnapshot): void {
  const dir = path.dirname(statusFile);
  mkdirSync(dir, { recursive: true });
  const tmp = `${statusFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o640 });
  renameSync(tmp, statusFile);
}

/**
 * Periodically write live_sessions from the supervised pool.
 * Ops reads the file over SSH — no gateway surface.
 */
export function installEnginePoolStatusControl(opts: EnginePoolStatusControlOptions): () => void {
  const statusFile = opts.statusFile?.trim() || defaultPoolStatusFile();
  const intervalMs = Math.max(250, opts.intervalMs ?? 1_000);

  const publish = (): void => {
    try {
      const snapshot = buildPoolStatusSnapshot(opts.engineId, opts.pool.sessionIds.length);
      writePoolStatusFile(statusFile, snapshot);
    } catch (e) {
      console.error(
        `[engine-pool-status] failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  publish();
  const timer = setInterval(publish, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
