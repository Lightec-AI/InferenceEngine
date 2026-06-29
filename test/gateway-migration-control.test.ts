import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installGatewayMigrationControl,
  readGatewayMigrationRequestFile,
} from "../src/engine/gateway-migration-control.js";

describe("gateway migration control", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads migration request file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-mig-"));
    const path = join(dir, "req.json");
    writeFileSync(path, '{"target_url":"https://10.0.0.1:8790","fraction":1}');
    const req = readGatewayMigrationRequestFile(path);
    expect(req.fraction).toBe(1);
  });

  it("runs migration on SIGUSR1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-mig-"));
    const path = join(dir, "req.json");
    writeFileSync(path, '{"target_url":"https://10.0.0.1:8790","fraction":0.5}');

    const migrate = vi.fn().mockResolvedValue({
      moved: 1,
      onTarget: 1,
      onSource: 1,
      targetCount: 1,
      blocked: false,
    });

    installGatewayMigrationControl({
      pool: { migrateGatewayPool: migrate } as never,
      engineId: "eng-1",
      requestFile: path,
    });

    process.emit("SIGUSR1" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 20));
    expect(migrate).toHaveBeenCalledWith("https://10.0.0.1:8790", 0.5);
  });
});
