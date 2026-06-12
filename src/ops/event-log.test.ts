import { afterEach, describe, expect, it } from "vitest";

import {
  logEvent,
  parseGatewayHost,
  resetEventLogForTests,
  setEventLogLevel,
  setEventLogSink,
} from "./event-log.js";

describe("inference-engine event-log", () => {
  afterEach(() => {
    resetEventLogForTests();
  });

  it("parses gateway host without credentials", () => {
    expect(parseGatewayHost("https://gateway.example.com:8788")).toBe("gateway.example.com");
  });

  it("filters below configured level", () => {
    const lines: string[] = [];
    setEventLogSink((line) => lines.push(line));
    setEventLogLevel("warn");
    logEvent("debug", "inference.engine", "work_assigned", { requestId: "r1" });
    logEvent("warn", "inference.engine", "pool_connect_failed", { engineId: "e1" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).event).toBe("pool_connect_failed");
  });
});
