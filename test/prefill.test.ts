import { describe, expect, it } from "vitest";

import { planVllmPrefill } from "../src/prefill.js";

describe("planVllmPrefill", () => {
  it("prefills full prompt on first turn", () => {
    const { plan, nextState } = planVllmPrefill(undefined, 120, "h1");
    expect(plan).toEqual({ warmPrefixTokens: 0, coldSuffixTokens: 120 });
    expect(nextState.prefilledTokens).toBe(120);
  });

  it("only prefills cold suffix when prefix hash matches", () => {
    const first = planVllmPrefill(undefined, 100, "h1");
    const { plan } = planVllmPrefill(first.nextState, 130, "h1");
    expect(plan.warmPrefixTokens).toBe(100);
    expect(plan.coldSuffixTokens).toBe(30);
  });

  it("re-prefills entire prompt when prefix hash changes", () => {
    const first = planVllmPrefill(undefined, 80, "h1");
    const { plan } = planVllmPrefill(first.nextState, 90, "h2");
    expect(plan.coldSuffixTokens).toBe(90);
    expect(plan.warmPrefixTokens).toBe(0);
  });
});
