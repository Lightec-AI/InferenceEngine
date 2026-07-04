import { describe, expect, it } from "vitest";

import { takeUtf16SafePrefix } from "../src/server/ope-chunk-text.js";

describe("takeUtf16SafePrefix", () => {
  it("does not split emoji surrogate pairs (avoids U+FFFD via Buffer.from)", () => {
    const pending = `Hello!!💡`; // 7 BMP + 1 supplementary (2 UTF-16 units)
    expect(pending.length).toBe(9);

    // Naive slice(0, 8) leaves a lone high surrogate → Buffer.from → U+FFFD.
    const naive = pending.slice(0, 8);
    expect(Buffer.from(naive, "utf8").toString("utf8")).toContain("\uFFFD");

    const { piece, rest } = takeUtf16SafePrefix(pending, 8);
    expect(piece).toBe("Hello!!");
    expect(rest).toBe("💡");
    expect(Buffer.from(piece, "utf8").toString("utf8")).toBe("Hello!!");
    expect(Buffer.from(rest, "utf8").toString("utf8")).toBe("💡");
    expect(piece + rest).toBe(pending);
  });

  it("emits a full supplementary char when budget is 1", () => {
    const { piece, rest } = takeUtf16SafePrefix("💡x", 1);
    expect(piece).toBe("💡");
    expect(rest).toBe("x");
    expect(Buffer.from(piece, "utf8").toString("utf8")).not.toContain("\uFFFD");
  });

  it("round-trips mixed CJK + emoji without replacement chars", () => {
    const text = "综合建议💡🚀完成";
    let pending = text;
    const out: string[] = [];
    while (pending.length > 0) {
      const { piece, rest } = takeUtf16SafePrefix(pending, 8);
      expect(piece.length).toBeGreaterThan(0);
      out.push(Buffer.from(piece, "utf8").toString("utf8"));
      pending = rest;
    }
    expect(out.join("")).toBe(text);
    expect(out.join("")).not.toContain("\uFFFD");
  });
});
