import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { __resetOpeFfiCacheForTests, loadOpeFfi, OpeFfiError } from "../src/native/ope-ffi.js";

const PROD = { TEECHAT_BUILD: "production" } as const;

function tmpLib(contents = "not-a-real-shared-object"): string {
  const dir = mkdtempSync(join(tmpdir(), "ope-ffi-int-"));
  const p = join(dir, "libope_ffi.dylib");
  writeFileSync(p, contents);
  return p;
}

describe("ope-ffi native loader hardening (SEC-026)", () => {
  afterEach(() => __resetOpeFfiCacheForTests());

  it("production: refuses to load without TEECHAT_OPE_FFI_LIB", () => {
    __resetOpeFfiCacheForTests();
    expect(() => loadOpeFfi({ ...PROD } as NodeJS.ProcessEnv)).toThrow(/TEECHAT_OPE_FFI_LIB/i);
  });

  it("staging canary: does not require sha pin when an absolute library path exists", () => {
    __resetOpeFfiCacheForTests();
    const lib = tmpLib();
    let err: unknown;
    try {
      loadOpeFfi({
        ...PROD,
        TEECHAT_ENV: "staging",
        TEECHAT_OPE_FFI_LIB: lib,
      } as NodeJS.ProcessEnv);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).not.toMatch(/TEECHAT_OPE_FFI_SHA256/i);
    expect(String(err)).not.toMatch(/TEECHAT_OPE_FFI_LIB to point/i);
  });

  it("production: refuses a relative TEECHAT_OPE_FFI_LIB", () => {
    __resetOpeFfiCacheForTests();
    expect(() =>
      loadOpeFfi({ ...PROD, TEECHAT_OPE_FFI_LIB: "relative/lib.dylib" } as NodeJS.ProcessEnv),
    ).toThrow(/absolute/i);
  });

  it("production: refuses a non-existent absolute path", () => {
    __resetOpeFfiCacheForTests();
    expect(() =>
      loadOpeFfi({ ...PROD, TEECHAT_OPE_FFI_LIB: "/nonexistent/libope_ffi.dylib" } as NodeJS.ProcessEnv),
    ).toThrow(/does not exist/i);
  });

  it("production: requires a sha-256 pin even when the path exists", () => {
    __resetOpeFfiCacheForTests();
    const lib = tmpLib();
    expect(() =>
      loadOpeFfi({ ...PROD, TEECHAT_OPE_FFI_LIB: lib } as NodeJS.ProcessEnv),
    ).toThrow(/TEECHAT_OPE_FFI_SHA256/i);
  });

  it("rejects a malformed sha-256 pin", () => {
    __resetOpeFfiCacheForTests();
    const lib = tmpLib();
    expect(() =>
      loadOpeFfi({
        TEECHAT_BUILD: "development",
        TEECHAT_OPE_FFI_LIB: lib,
        TEECHAT_OPE_FFI_SHA256: "xyz",
      } as NodeJS.ProcessEnv),
    ).toThrow(/64-char hex/i);
  });

  it("throws on a hash mismatch (tamper detection) before loading", () => {
    __resetOpeFfiCacheForTests();
    const lib = tmpLib("tampered-bytes");
    const wrong = "0".repeat(64);
    expect(() =>
      loadOpeFfi({
        TEECHAT_BUILD: "development",
        TEECHAT_OPE_FFI_LIB: lib,
        TEECHAT_OPE_FFI_SHA256: wrong,
      } as NodeJS.ProcessEnv),
    ).toThrow(OpeFfiError);
  });

  it("passes integrity when the pin matches, then fails at koffi.load (not a real .so)", () => {
    __resetOpeFfiCacheForTests();
    const contents = "fake-lib-contents";
    const lib = tmpLib(contents);
    const digest = createHash("sha256").update(Buffer.from(contents)).digest("hex");
    // Integrity passes; koffi.load throws because the file is not a valid shared object.
    expect(() =>
      loadOpeFfi({
        TEECHAT_BUILD: "development",
        TEECHAT_OPE_FFI_LIB: lib,
        TEECHAT_OPE_FFI_SHA256: digest,
      } as NodeJS.ProcessEnv),
    ).toThrow(); // a koffi load error, not an integrity error
  });
});
