import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installEnginePoolScaleControl,
  readPoolScaleRequestFile,
} from "../src/engine/pool-scale-control.js";
import { parsePoolScaleRequestJson } from "../src/engine/pool-cutover.js";

describe("pool scale control", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses scale request", () => {
    expect(parsePoolScaleRequestJson('{"target_size":2}').target_size).toBe(2);
  });

  it("reads scale request file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-scale-"));
    const path = join(dir, "req.json");
    writeFileSync(path, '{"target_size":2}');
    expect(readPoolScaleRequestFile(path).target_size).toBe(2);
  });

  it("runs scale on SIGUSR3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-scale-"));
    const path = join(dir, "req.json");
    writeFileSync(path, '{"target_size":2}');

    const scale = vi.fn().mockResolvedValue({
      added: 1,
      total: 2,
      targetSize: 2,
      blocked: false,
    });

    installEnginePoolScaleControl({
      pool: { scalePool: scale } as never,
      engineId: "eng-1",
      requestFile: path,
    });

    process.emit("SIGUSR3" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 20));
    expect(scale).toHaveBeenCalledWith(2);
  });
});
