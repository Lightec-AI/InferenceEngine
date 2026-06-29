import { describe, expect, it } from "vitest";

import {
  parseGatewayMigrationRequestJson,
  planGatewayMigration,
} from "../src/engine/gateway-migration.js";

describe("planGatewayMigration", () => {
  it("plans half migration for pool size 2", () => {
    const plan = planGatewayMigration({
      poolSize: 2,
      onTarget: 0,
      fraction: 0.5,
      idleOnSource: 2,
    });
    expect(plan.targetCount).toBe(1);
    expect(plan.toMove).toBe(1);
    expect(plan.blocked).toBe(false);
  });

  it("blocks when idle sessions insufficient", () => {
    const plan = planGatewayMigration({
      poolSize: 2,
      onTarget: 0,
      fraction: 1,
      idleOnSource: 1,
    });
    expect(plan.targetCount).toBe(2);
    expect(plan.toMove).toBe(1);
    expect(plan.blocked).toBe(true);
    expect(plan.reason).toBe("insufficient_idle_sessions");
  });

  it("moves zero when already at target fraction", () => {
    const plan = planGatewayMigration({
      poolSize: 2,
      onTarget: 1,
      fraction: 0.5,
      idleOnSource: 1,
    });
    expect(plan.toMove).toBe(0);
  });
});

describe("parseGatewayMigrationRequestJson", () => {
  it("parses request file body", () => {
    const req = parseGatewayMigrationRequestJson(
      '{"target_url":"https://10.0.0.1:8790","fraction":0.5}',
    );
    expect(req.target_url).toBe("https://10.0.0.1:8790");
    expect(req.fraction).toBe(0.5);
  });
});
