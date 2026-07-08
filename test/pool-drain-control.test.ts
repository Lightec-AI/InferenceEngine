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
    process.removeAllListeners("SIGUSR2");
  });

  it("reads drain request file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-drain-"));
    const path = join(dir, "req.json");
    writeFileSync(path, '{"fraction":0.5}');
    const req = readPoolDrainRequestFile(path);
    expect(req.fraction).toBe(0.5);
  });

  it("reads count drain request file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-drain-"));
    const path = join(dir, "req.json");
    writeFileSync(path, '{"count":1}');
    const req = readPoolDrainRequestFile(path);
    expect(req.count).toBe(1);
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
      pool: { drainIdlePool: drain, drainIdleSessions: vi.fn() } as never,
      engineId: "eng-1",
      requestFile: path,
    });

    process.emit("SIGUSR2" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 20));
    expect(drain).toHaveBeenCalledWith(1);
  });

  it("runs drainIdleSessions on SIGUSR2 when count is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-drain-"));
    const path = join(dir, "req.json");
    writeFileSync(path, '{"count":1}');

    const drainSessions = vi.fn().mockResolvedValue({
      drained: 1,
      remaining: 3,
      targetRemaining: 3,
      blocked: false,
    });

    installEnginePoolDrainControl({
      pool: {
        drainIdlePool: vi.fn(),
        drainIdleSessions: drainSessions,
      } as never,
      engineId: "eng-1",
      requestFile: path,
    });

    process.emit("SIGUSR2" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 20));
    expect(drainSessions).toHaveBeenCalledWith(1);
  });
});
