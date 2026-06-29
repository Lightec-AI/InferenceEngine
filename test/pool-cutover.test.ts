import { describe, expect, it } from "vitest";

import {
  initialPoolSessionCount,
  parsePoolDrainRequestJson,
  parsePoolScaleRequestJson,
  planPoolDrain,
  planPoolScale,
  poolInitialFractionFromEnv,
} from "../src/engine/pool-cutover.js";

describe("initialPoolSessionCount", () => {
  it("opens half pool for N=2", () => {
    expect(initialPoolSessionCount(2, 0.5)).toBe(1);
  });

  it("opens half pool for N=4", () => {
    expect(initialPoolSessionCount(4, 0.5)).toBe(2);
  });

  it("opens full pool when fraction is 1", () => {
    expect(initialPoolSessionCount(2, 1)).toBe(2);
  });

  it("returns zero when fraction is zero", () => {
    expect(initialPoolSessionCount(2, 0)).toBe(0);
  });
});

describe("planPoolDrain", () => {
  it("plans half drain for pool size 2", () => {
    const plan = planPoolDrain({
      poolTargetSize: 2,
      currentCount: 2,
      fraction: 0.5,
      idleCount: 2,
    });
    expect(plan.toDrain).toBe(1);
    expect(plan.targetRemaining).toBe(1);
    expect(plan.blocked).toBe(false);
  });

  it("drains all remaining when fraction is 1", () => {
    const plan = planPoolDrain({
      poolTargetSize: 2,
      currentCount: 1,
      fraction: 1,
      idleCount: 1,
    });
    expect(plan.toDrain).toBe(1);
    expect(plan.targetRemaining).toBe(0);
    expect(plan.blocked).toBe(false);
  });

  it("blocks when idle sessions insufficient", () => {
    const plan = planPoolDrain({
      poolTargetSize: 2,
      currentCount: 2,
      fraction: 1,
      idleCount: 1,
    });
    expect(plan.toDrain).toBe(1);
    expect(plan.blocked).toBe(true);
    expect(plan.reason).toBe("insufficient_idle_sessions");
  });

  it("drains zero when already at target remaining", () => {
    const plan = planPoolDrain({
      poolTargetSize: 2,
      currentCount: 1,
      fraction: 0.5,
      idleCount: 1,
    });
    expect(plan.toDrain).toBe(0);
    expect(plan.targetRemaining).toBe(1);
  });

  it("rejects invalid fraction", () => {
    const plan = planPoolDrain({
      poolTargetSize: 2,
      currentCount: 2,
      fraction: 1.5,
      idleCount: 2,
    });
    expect(plan.blocked).toBe(true);
    expect(plan.reason).toBe("invalid_fraction");
  });
});

describe("planPoolScale", () => {
  it("plans adding one session to reach full pool", () => {
    const plan = planPoolScale({
      poolTargetSize: 2,
      currentCount: 1,
      targetSize: 2,
    });
    expect(plan.toAdd).toBe(1);
    expect(plan.blocked).toBe(false);
  });

  it("plans zero adds when already at target", () => {
    const plan = planPoolScale({
      poolTargetSize: 2,
      currentCount: 2,
      targetSize: 2,
    });
    expect(plan.toAdd).toBe(0);
  });

  it("blocks target above poolTargetSize", () => {
    const plan = planPoolScale({
      poolTargetSize: 2,
      currentCount: 1,
      targetSize: 3,
    });
    expect(plan.blocked).toBe(true);
    expect(plan.reason).toBe("invalid_target_size");
  });
});

describe("parsePoolScaleRequestJson", () => {
  it("parses target_size", () => {
    expect(parsePoolScaleRequestJson('{"target_size":2}').target_size).toBe(2);
  });
});

describe("parsePoolDrainRequestJson", () => {
  it("parses fraction", () => {
    expect(parsePoolDrainRequestJson('{"fraction":0.5}').fraction).toBe(0.5);
  });

  it("rejects invalid fraction", () => {
    expect(() => parsePoolDrainRequestJson('{"fraction":2}')).toThrow(/fraction/);
  });
});

describe("poolInitialFractionFromEnv", () => {
  it("defaults to 1", () => {
    expect(poolInitialFractionFromEnv({})).toBe(1);
  });

  it("reads TEECHAT_ENGINE_POOL_INITIAL_FRACTION", () => {
    expect(
      poolInitialFractionFromEnv({ TEECHAT_ENGINE_POOL_INITIAL_FRACTION: "0.5" }),
    ).toBe(0.5);
  });

  it("falls back to 1 on invalid env", () => {
    expect(
      poolInitialFractionFromEnv({ TEECHAT_ENGINE_POOL_INITIAL_FRACTION: "bad" }),
    ).toBe(1);
  });
});
