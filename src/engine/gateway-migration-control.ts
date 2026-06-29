/**
 * Runtime gateway migration control — USR1 + JSON request file (no engine process restart).
 */

import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { SupervisedEnginePlanePool } from "./supervised-pool.js";
import { parseGatewayMigrationRequestJson } from "./gateway-migration.js";
import { logEnginePoolConnect } from "../ops/engine-events.js";

export interface GatewayMigrationControlOptions {
  pool: SupervisedEnginePlanePool;
  requestFile?: string;
  engineId: string;
  onMigrated?: (result: Awaited<ReturnType<SupervisedEnginePlanePool["migrateGatewayPool"]>>) => void;
}

export function readGatewayMigrationRequestFile(path: string): {
  target_url: string;
  fraction: number;
} {
  const raw = readFileSync(path, "utf8");
  return parseGatewayMigrationRequestJson(raw);
}

export function installGatewayMigrationControl(opts: GatewayMigrationControlOptions): void {
  const requestFile =
    opts.requestFile?.trim() ||
    process.env.TEECHAT_ENGINE_GATEWAY_MIGRATION_FILE?.trim() ||
    "/etc/teechat/engine-gateway-migration.json";

  let handling = false;

  const runMigration = async (): Promise<void> => {
    if (handling) return;
    handling = true;
    try {
      const req = readGatewayMigrationRequestFile(requestFile);
      const result = await opts.pool.migrateGatewayPool(req.target_url, req.fraction);
      logEnginePoolConnect(opts.engineId, req.target_url, randomUUID());
      opts.onMigrated?.(result);
      try {
        unlinkSync(requestFile);
      } catch {
        /* best-effort */
      }
    } catch (e) {
      console.error(
        `[engine-gateway-migration] failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      handling = false;
    }
  };

  process.on("SIGUSR1", () => {
    void runMigration();
  });
}
