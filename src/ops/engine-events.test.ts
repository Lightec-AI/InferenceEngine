import { afterEach, describe, expect, it } from "vitest";

import { logEnginePoolConnect, logEngineVllmUpstreamError } from "./engine-events.js";
import { resetEventLogForTests, setEventLogLevel, setEventLogSink } from "./event-log.js";

describe("engine-events", () => {
  afterEach(() => {
    resetEventLogForTests();
  });

  it("logs pool connect with gateway host only", () => {
    const lines: string[] = [];
    setEventLogSink((line) => lines.push(line));
    setEventLogLevel("info");
    logEnginePoolConnect("engine-1", "https://127.0.0.1:8788", "sess-1");
    const record = JSON.parse(lines[0]!) as { fields?: Record<string, unknown> };
    expect(record.fields).toMatchObject({
      engineId: "engine-1",
      gatewayHost: "127.0.0.1",
      sessionId: "sess-1",
    });
  });

  it("logs vLLM upstream failures at ERROR", () => {
    const lines: string[] = [];
    setEventLogSink((line) => lines.push(line));
    setEventLogLevel("error");
    logEngineVllmUpstreamError("req-9", 503, new Error("vLLM HTTP 503: overloaded"));
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "error",
      event: "vllm_upstream_failed",
    });
  });
});
