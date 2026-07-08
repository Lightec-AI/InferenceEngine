import { describe, expect, it } from "vitest";

import {
  PoolConnectThrottle,
  initialPoolSessionCount,
  mapWithConcurrency,
  parsePoolDrainRequestJson,
  parsePoolScaleRequestJson,
  planPoolDrain,
  planPoolScale,
  poolConnectConcurrencyFromEnv,
  poolConnectStaggerMsFromEnv,
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

  it("drains by count mid-migrate (fraction-of-N would no-op)", () => {
    // Blue holds 20 of N=32; fraction=1/32 wants remaining=31 → drains 0.
    const byFraction = planPoolDrain({
      poolTargetSize: 32,
      currentCount: 20,
      fraction: 1 / 32,
      idleCount: 20,
    });
    expect(byFraction.toDrain).toBe(0);

    const byCount = planPoolDrain({
      poolTargetSize: 32,
      currentCount: 20,
      count: 1,
      idleCount: 20,
    });
    expect(byCount.toDrain).toBe(1);
    expect(byCount.targetRemaining).toBe(19);
    expect(byCount.blocked).toBe(false);
  });

  it("blocks count drain when idle insufficient", () => {
    const plan = planPoolDrain({
      poolTargetSize: 32,
      currentCount: 10,
      count: 2,
      idleCount: 1,
    });
    expect(plan.toDrain).toBe(1);
    expect(plan.blocked).toBe(true);
    expect(plan.reason).toBe("insufficient_idle_sessions");
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

  it("parses count for paired stepper", () => {
    expect(parsePoolDrainRequestJson('{"count":1}')).toEqual({ count: 1 });
  });

  it("prefers count when both present", () => {
    expect(parsePoolDrainRequestJson('{"count":2,"fraction":0.5}')).toEqual({ count: 2 });
  });

  it("rejects invalid fraction", () => {
    expect(() => parsePoolDrainRequestJson('{"fraction":2}')).toThrow(/fraction/);
  });

  it("rejects invalid count", () => {
    expect(() => parsePoolDrainRequestJson('{"count":0}')).toThrow(/count/);
  });

  it("rejects empty object", () => {
    expect(() => parsePoolDrainRequestJson("{}")).toThrow(/fraction|count/);
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

describe("poolConnectConcurrencyFromEnv", () => {
  it("defaults to throttled concurrency (not full parallel)", () => {
    expect(poolConnectConcurrencyFromEnv({}, 16)).toBe(2);
    expect(poolConnectConcurrencyFromEnv({}, 1)).toBe(1);
  });

  it("allows unlimited via 0 or unlimited", () => {
    expect(poolConnectConcurrencyFromEnv({ TEECHAT_ENGINE_POOL_CONNECT_CONCURRENCY: "0" }, 8)).toBe(8);
    expect(
      poolConnectConcurrencyFromEnv({ TEECHAT_ENGINE_POOL_CONNECT_CONCURRENCY: "unlimited" }, 8),
    ).toBe(8);
  });

  it("caps by session count", () => {
    expect(poolConnectConcurrencyFromEnv({ TEECHAT_ENGINE_POOL_CONNECT_CONCURRENCY: "4" }, 16)).toBe(4);
    expect(poolConnectConcurrencyFromEnv({ TEECHAT_ENGINE_POOL_CONNECT_CONCURRENCY: "99" }, 3)).toBe(3);
  });
});

describe("poolConnectStaggerMsFromEnv", () => {
  it("defaults to a positive stagger", () => {
    expect(poolConnectStaggerMsFromEnv({})).toBeGreaterThan(0);
    expect(poolConnectStaggerMsFromEnv({ TEECHAT_ENGINE_POOL_CONNECT_STAGGER_MS: "0" })).toBe(0);
    expect(poolConnectStaggerMsFromEnv({ TEECHAT_ENGINE_POOL_CONNECT_STAGGER_MS: "250" })).toBe(250);
  });
});

describe("PoolConnectThrottle", () => {
  it("limits in-flight work and spaces starts", async () => {
    const throttle = new PoolConnectThrottle(2, 20);
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        throttle.run(async () => {
          starts.push(Date.now() - t0);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 30));
          inFlight -= 1;
        }),
      ),
    );
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(starts.length).toBe(4);
    // Starts should not all cluster at t=0 when stagger is enabled.
    expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThanOrEqual(15);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order and limits in-flight work", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await mapWithConcurrency(6, 2, async (index) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return index * 2;
    });
    expect(results).toEqual([0, 2, 4, 6, 8, 10]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
