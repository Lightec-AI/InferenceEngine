import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ENGINE_POOL_STATUS_SCHEMA,
  buildPoolStatusSnapshot,
  installEnginePoolStatusControl,
  writePoolStatusFile,
} from "../src/engine/pool-status-control.js";

describe("pool status control", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a status snapshot", () => {
    const snap = buildPoolStatusSnapshot(
      "eng-1",
      16,
      { "https://10.0.0.1:8788": 8, "https://10.0.0.1:8790": 8 },
      new Date("2026-07-04T00:00:00.000Z"),
    );
    expect(snap).toEqual({
      schema: ENGINE_POOL_STATUS_SCHEMA,
      engine_id: "eng-1",
      live_sessions: 16,
      sessions_by_gateway_url: { "https://10.0.0.1:8788": 8, "https://10.0.0.1:8790": 8 },
      updated_at: "2026-07-04T00:00:00.000Z",
    });
  });

  it("writes status atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-status-"));
    const path = join(dir, "status.json");
    writePoolStatusFile(path, buildPoolStatusSnapshot("eng-1", 4));
    const body = JSON.parse(readFileSync(path, "utf8")) as { live_sessions: number };
    expect(body.live_sessions).toBe(4);
  });

  it("publishes live_sessions from the pool on an interval", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "pool-status-"));
    const path = join(dir, "status.json");
    const sessionIds = ["a", "b"];

    const stop = installEnginePoolStatusControl({
      pool: {
        sessionIds,
        sessionsByGatewayUrl: () => ({ "https://127.0.0.1:8788": sessionIds.length }),
      },
      engineId: "eng-1",
      statusFile: path,
      intervalMs: 1000,
    });

    expect(JSON.parse(readFileSync(path, "utf8")).live_sessions).toBe(2);
    sessionIds.push("c");
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(readFileSync(path, "utf8")).live_sessions).toBe(3);
    stop();
    vi.useRealTimers();
  });
});
