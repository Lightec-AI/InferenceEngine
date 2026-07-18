#!/usr/bin/env node
/**
 * Download measured libope_ffi.so from the OPE GitHub Release pinned in config/tcb-pins.json.
 * Prefer this over `build:ffi` (local cargo) for CI and production-shaped layouts.
 *
 * Env:
 *   TEECHAT_OPE_FFI_OUT — destination path (default: ./native/libope_ffi.so)
 *   TEECHAT_OPE_FFI_URL — override asset URL
 *   TEECHAT_EXPECT_OPE_FFI_SHA256 — override expected digest
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pins = JSON.parse(readFileSync(resolve(root, "config/tcb-pins.json"), "utf8"));
const ope = pins.ope ?? {};

const expectSha = (
  process.env.TEECHAT_EXPECT_OPE_FFI_SHA256?.trim() ||
  ope.libopeFfiSha256 ||
  ""
).toLowerCase();
const url =
  process.env.TEECHAT_OPE_FFI_URL?.trim() ||
  ope.assetUrl ||
  (ope.tag
    ? `https://github.com/Lightec-AI/OPE/releases/download/${ope.tag}/libope_ffi.so`
    : "");
const out = resolve(
  process.env.TEECHAT_OPE_FFI_OUT?.trim() || resolve(root, "native/libope_ffi.so"),
);

if (!url) {
  console.error("[fetch-ope-ffi] no asset URL (set TEECHAT_OPE_FFI_URL or config/tcb-pins.json)");
  process.exit(1);
}
if (!/^[0-9a-f]{64}$/.test(expectSha)) {
  console.error("[fetch-ope-ffi] missing/invalid libopeFfiSha256 pin");
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
console.error(`[fetch-ope-ffi] GET ${url}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok || !res.body) {
  console.error(`[fetch-ope-ffi] HTTP ${res.status}`);
  process.exit(1);
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(out));

const got = createHash("sha256").update(readFileSync(out)).digest("hex");
if (got !== expectSha) {
  console.error(`[fetch-ope-ffi] digest mismatch\n  got:  ${got}\n  want: ${expectSha}`);
  process.exit(1);
}
console.error(`[fetch-ope-ffi] ok ${got.slice(0, 16)}… → ${out}`);
if (!existsSync(out)) process.exit(1);
