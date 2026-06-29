import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installEnginePoolDrainControl,
  readPoolDrainRequestFile,
} from "../src/engine/pool-drain-control.js";

describe("engine pool drain control", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads drain request file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-drain-"));
    const path = join(dir, "req.json");
    writeFileSync(path, '{"fraction":0.5}');
    const req = readPoolDrainRequestFile(path);
    expect(req.fraction).toBe(0.5);
  });

  it("runs drain on SIGUSR2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-drain-"));
    const path = join(dir, "req.json");
    writeFileSync(path, '{"fraction":1}');

    const drain = vi.fn().mockResolvedValue({
      drained: 1,
      remaining: 0,
      targetRemaining: 0,
      blocked: false,
    });

    installEnginePoolDrainControl({
      pool: { drainIdlePool: drain } as never,
      engineId: "eng-1",
      requestFile: path,
    });

    process.emit("SIGUSR2" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 20));
    expect(drain).toHaveBeenCalledWith(1);
  });
});
