import { describe, expect, it } from "vitest";

import {
  DEFAULT_ENGINE_INSTANCE_ID,
  engineInstanceIdFromEnv,
  normalizeEngineInstanceId,
} from "../src/engine/instance-id.js";

describe("engine instance id", () => {
  it("defaults empty to default", () => {
    expect(normalizeEngineInstanceId(undefined)).toBe(DEFAULT_ENGINE_INSTANCE_ID);
    expect(normalizeEngineInstanceId("")).toBe(DEFAULT_ENGINE_INSTANCE_ID);
    expect(normalizeEngineInstanceId("  ")).toBe(DEFAULT_ENGINE_INSTANCE_ID);
  });

  it("accepts blue and green slots", () => {
    expect(normalizeEngineInstanceId("blue")).toBe("blue");
    expect(normalizeEngineInstanceId("green")).toBe("green");
  });

  it("rejects invalid ids", () => {
    expect(() => normalizeEngineInstanceId("../x")).toThrow(/invalid_instance_id/);
    expect(() => normalizeEngineInstanceId("a b")).toThrow(/invalid_instance_id/);
  });

  it("reads instance id from env", () => {
    expect(engineInstanceIdFromEnv({ TEECHAT_ENGINE_INSTANCE_ID: "blue" })).toBe("blue");
    expect(engineInstanceIdFromEnv({ TEECHAT_ENGINE_SLOT: "green" })).toBe("green");
    expect(engineInstanceIdFromEnv({ TEECHAT_ENGINE_INSTANCE_ID: "custom", TEECHAT_ENGINE_SLOT: "blue" })).toBe(
      "custom",
    );
    expect(engineInstanceIdFromEnv({})).toBe(DEFAULT_ENGINE_INSTANCE_ID);
  });
});
