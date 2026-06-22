import { describe, expect, it } from "vitest";

import { encodeOpeStreamLine, encodeOpeStatusLine, parseOpeStreamLine } from "./ope-stream.js";

describe("ope-stream framing", () => {
  it("round-trips header and chunk lines", () => {
    const header = encodeOpeStreamLine({ ope_stream: "1.0", server_share: "sh" });
    const chunk = encodeOpeStreamLine({
      ope_stream: "1.0",
      seq: 0,
      ciphertext: "ct",
      final: false,
    });
    expect(parseOpeStreamLine(header.toString("utf8").trim())).toEqual({
      ope_stream: "1.0",
      server_share: "sh",
    });
    expect(parseOpeStreamLine(chunk.toString("utf8").trim())).toEqual({
      ope_stream: "1.0",
      seq: 0,
      ciphertext: "ct",
      final: false,
    });
  });

  it("parses trailer usage", () => {
    const line = encodeOpeStreamLine({
      ope_stream: "1.0",
      type: "trailer",
      usage_report: "usage-b64",
    });
    expect(parseOpeStreamLine(line.toString("utf8").trim())).toEqual({
      ope_stream: "1.0",
      type: "trailer",
      usage_report: "usage-b64",
    });
  });

  it("parses plaintext status frames", () => {
    const line = encodeOpeStatusLine("thinking");
    expect(parseOpeStreamLine(line.toString("utf8").trim())).toEqual({
      ope_stream: "1.0",
      type: "status",
      phase: "thinking",
    });
  });
});
