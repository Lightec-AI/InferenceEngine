import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ClientHttp2Session } from "node:http2";

import { attachPooledSessionErrorListeners } from "../src/engine-plane/pool-client.js";
import { resetEventLogForTests, setEventLogLevel, setEventLogSink } from "../src/ops/event-log.js";

describe("attachPooledSessionErrorListeners", () => {
  it("logs session errors and forwards to onError", () => {
    resetEventLogForTests();
    const lines: string[] = [];
    setEventLogSink((line) => lines.push(line));
    setEventLogLevel("warn");

    const session = new EventEmitter() as ClientHttp2Session;
    const onError = vi.fn();
    attachPooledSessionErrorListeners(session, {
      engineId: "engine-test",
      sessionId: "sess-1",
      onError,
    });

    session.emit("error", new Error("h2 goaway"));
    expect(onError).toHaveBeenCalledOnce();
    expect(lines.some((l) => l.includes("pool_session_error"))).toBe(true);
  });
});
