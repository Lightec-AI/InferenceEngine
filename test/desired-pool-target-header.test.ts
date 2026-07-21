import { describe, expect, it } from "vitest";

import {
  HEADER_OPE_DESIRED_POOL_TARGET,
  parseDesiredPoolTargetHeader,
} from "../src/engine-plane/pool-client.js";

describe("parseDesiredPoolTargetHeader", () => {
  it("parses positive integers", () => {
    expect(HEADER_OPE_DESIRED_POOL_TARGET).toBe("x-ope-desired-pool-target");
    expect(parseDesiredPoolTargetHeader("12")).toBe(12);
    expect(parseDesiredPoolTargetHeader(["8"])).toBe(8);
  });

  it("ignores missing or malformed values", () => {
    expect(parseDesiredPoolTargetHeader(undefined)).toBeUndefined();
    expect(parseDesiredPoolTargetHeader("")).toBeUndefined();
    expect(parseDesiredPoolTargetHeader("0")).toBeUndefined();
    expect(parseDesiredPoolTargetHeader("1.5")).toBeUndefined();
    expect(parseDesiredPoolTargetHeader("nope")).toBeUndefined();
  });
});
