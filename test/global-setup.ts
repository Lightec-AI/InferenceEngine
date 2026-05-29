import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the `ope-ffi` cdylib once before the suite so native-crypto tests can load it.
 * Failures are non-fatal: tests that require the library assert availability themselves.
 */
export default function setup(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = resolve(here, "..", "scripts", "build-ope-ffi.mjs");
  try {
    execFileSync(process.execPath, [script], { stdio: "inherit" });
  } catch (e) {
    console.warn(`[test:global-setup] ope-ffi build skipped: ${e instanceof Error ? e.message : e}`);
  }
}
