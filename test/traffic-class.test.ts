import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPE_TRAFFIC_CLASS,
  HEADER_OPE_TRAFFIC_CLASS,
  OPE_TRAFFIC_CLASS_API,
  OPE_TRAFFIC_CLASS_LIVE_CHAT,
  isOpeTrafficClass,
  opeTrafficClassQosRank,
  parseOpeTrafficClass,
  resolveOpeTrafficClass,
  shouldMeterSubscriptionUsage,
  trafficClassHeaderMetaConsistent,
} from "../src/protocol/types.js";

describe("OPE traffic_class protocol", () => {
  it("exports the locked header name", () => {
    expect(HEADER_OPE_TRAFFIC_CLASS).toBe("x-ope-traffic-class");
  });

  it("accepts only live_chat and api", () => {
    expect(isOpeTrafficClass("live_chat")).toBe(true);
    expect(isOpeTrafficClass("api")).toBe(true);
    expect(isOpeTrafficClass("agent")).toBe(false);
    expect(isOpeTrafficClass("")).toBe(false);
    expect(isOpeTrafficClass(null)).toBe(false);
  });

  it("parses with trim + lowercase", () => {
    expect(parseOpeTrafficClass(" Live_Chat ")).toBe(OPE_TRAFFIC_CLASS_LIVE_CHAT);
    expect(parseOpeTrafficClass("API")).toBe(OPE_TRAFFIC_CLASS_API);
    expect(parseOpeTrafficClass("bot")).toBeNull();
    expect(parseOpeTrafficClass(1)).toBeNull();
  });

  it("resolve never invents api for unknown values", () => {
    expect(resolveOpeTrafficClass(undefined)).toBe(DEFAULT_OPE_TRAFFIC_CLASS);
    expect(resolveOpeTrafficClass("unknown")).toBe(OPE_TRAFFIC_CLASS_LIVE_CHAT);
    expect(resolveOpeTrafficClass("api")).toBe(OPE_TRAFFIC_CLASS_API);
  });

  it("ranks live_chat ahead of api for QoS", () => {
    expect(opeTrafficClassQosRank(OPE_TRAFFIC_CLASS_LIVE_CHAT)).toBeLessThan(
      opeTrafficClassQosRank(OPE_TRAFFIC_CLASS_API),
    );
  });

  it("meters subscription only for live_chat", () => {
    expect(shouldMeterSubscriptionUsage(OPE_TRAFFIC_CLASS_LIVE_CHAT)).toBe(true);
    expect(shouldMeterSubscriptionUsage(OPE_TRAFFIC_CLASS_API)).toBe(false);
  });

  it("requires header/meta agreement when both set", () => {
    expect(trafficClassHeaderMetaConsistent("live_chat", "live_chat")).toEqual({
      ok: true,
      trafficClass: "live_chat",
    });
    expect(trafficClassHeaderMetaConsistent("api", undefined)).toEqual({
      ok: true,
      trafficClass: "api",
    });
    expect(trafficClassHeaderMetaConsistent(undefined, "api")).toEqual({
      ok: true,
      trafficClass: "api",
    });
    expect(trafficClassHeaderMetaConsistent("live_chat", "api")).toMatchObject({
      ok: false,
    });
    expect(trafficClassHeaderMetaConsistent(undefined, undefined)).toMatchObject({
      ok: false,
    });
  });
});
