#!/usr/bin/env node
/**
 * Build the `ope-ffi` cdylib consumed by the Node binding (`src/native/ope-ffi.ts`).
 *
 * Resolves the OPE workspace from `TEECHAT_OPE_DIR` or the sibling `../ope` directory
 * (the TeaChat monorepo layout). Builds the release profile by default; set
 * `TEECHAT_FFI_PROFILE=debug` for a debug build.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

const opeDir = process.env.TEECHAT_OPE_DIR
  ? resolve(process.env.TEECHAT_OPE_DIR)
  : resolve(packageRoot, "..", "ope");

if (!existsSync(resolve(opeDir, "Cargo.toml"))) {
  console.error(`[build-ope-ffi] OPE workspace not found at ${opeDir}.`);
  console.error("[build-ope-ffi] Set TEECHAT_OPE_DIR to the vendor/ope checkout.");
  process.exit(1);
}

const profile = (process.env.TEECHAT_FFI_PROFILE ?? "release").toLowerCase();
const args = ["build", "-p", "ope-ffi"];
if (profile !== "debug") args.push("--release");

console.error(`[build-ope-ffi] cargo ${args.join(" ")} (cwd=${opeDir})`);
try {
  execFileSync("cargo", args, { cwd: opeDir, stdio: "inherit" });
} catch (e) {
  console.error(`[build-ope-ffi] cargo build failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
console.error("[build-ope-ffi] done.");
