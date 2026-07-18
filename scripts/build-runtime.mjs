#!/usr/bin/env node
/**
 * Bundle InferenceEngine process entrypoint to dist/inference-engine.mjs (no tsx).
 * Native addons stay external (koffi).
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = resolve(root, "dist");
const outfile = resolve(outDir, "inference-engine.mjs");

mkdirSync(outDir, { recursive: true });

const entry = resolve(root, "scripts/run-engine.ts");
const commonArgs = [
  entry,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node20",
  `--outfile=${outfile}`,
  "--external:koffi",
  "--packages=bundle",
  "--banner:js=import { createRequire as __ieCreateRequire } from 'node:module'; const require = __ieCreateRequire(import.meta.url);",
];

let built = false;
try {
  const esbuildBin = require.resolve("esbuild/bin/esbuild");
  execFileSync(process.execPath, [esbuildBin, ...commonArgs], { stdio: "inherit", cwd: root });
  built = true;
} catch {
  // fall through
}
if (!built) {
  console.error("[build-runtime] local esbuild missing — using npx esbuild@0.25.0");
  const quoted = commonArgs.map((a) => JSON.stringify(a)).join(" ");
  execSync(`npx --yes esbuild@0.25.0 ${quoted}`, {
    stdio: "inherit",
    cwd: root,
    shell: true,
  });
}

writeFileSync(
  resolve(outDir, "package.json"),
  JSON.stringify(
    {
      name: "@teechat/inference-engine-runtime",
      private: true,
      type: "module",
      bin: { "teechat-inference-engine": "./inference-engine.mjs" },
    },
    null,
    2,
  ) + "\n",
);

console.error(`[build-runtime] wrote ${outfile}`);
