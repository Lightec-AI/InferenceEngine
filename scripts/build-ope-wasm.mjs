#!/usr/bin/env node
/**
 * Build `ope-wasm` for browser / Capacitor WebView (wasm-pack, target `web`).
 *
 * Output: `vendor/inference-engine/pkg/ope-wasm/`
 * Requires: Rust toolchain + `wasm32-unknown-unknown` (wasm-pack installs target if needed).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");

const opeDir = process.env.TEECHAT_OPE_DIR
  ? resolve(process.env.TEECHAT_OPE_DIR)
  : resolve(repoRoot, "vendor", "ope");

const outDir = resolve(packageRoot, "pkg", "ope-wasm");

if (!existsSync(resolve(opeDir, "Cargo.toml"))) {
  console.error(`[build-ope-wasm] OPE workspace not found at ${opeDir}`);
  process.exit(1);
}

const wasmPack =
  process.env.WASM_PACK_BIN ??
  resolve(repoRoot, "node_modules", ".bin", "wasm-pack");
const args = [
  "build",
  "crates/ope-wasm",
  "--target",
  "web",
  "--release",
  "--out-dir",
  outDir,
  "--out-name",
  "ope_wasm",
];

console.error(`[build-ope-wasm] ${wasmPack} ${args.join(" ")} (cwd=${opeDir})`);
try {
  execFileSync(wasmPack, args, { cwd: opeDir, stdio: "inherit" });
} catch (e) {
  console.error(`[build-ope-wasm] failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
console.error(`[build-ope-wasm] artifacts in ${outDir}`);
