#!/usr/bin/env node
/**
 * Pack measured IE runtime tarball + SHA256SUMS (+ optional companion .so from pins).
 *
 * Env:
 *   TEECHAT_IE_PACK_OUT — output dir (default: dist/release)
 *   TEECHAT_IE_INCLUDE_NATIVES=1 — also fetch/attach libope_ffi.so + libattested_mtls.so
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const version = (
  process.env.TEECHAT_ENGINE_BUILD_VERSION?.trim() ||
  JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version
).replace(/^v/, "");
const outDir = resolve(process.env.TEECHAT_IE_PACK_OUT?.trim() || resolve(root, "dist/release"));
const includeNatives = process.env.TEECHAT_IE_INCLUDE_NATIVES === "1";

mkdirSync(outDir, { recursive: true });

execFileSync(process.execPath, [resolve(here, "build-runtime.mjs")], {
  stdio: "inherit",
  cwd: root,
});

const bundle = resolve(root, "dist/inference-engine.mjs");
if (!existsSync(bundle)) {
  console.error("[pack-runtime] missing dist/inference-engine.mjs");
  process.exit(1);
}

const stage = resolve(outDir, "stage");
mkdirSync(stage, { recursive: true });
copyFileSync(bundle, resolve(stage, "inference-engine.mjs"));
copyFileSync(resolve(root, "dist/package.json"), resolve(stage, "package.json"));
copyFileSync(resolve(root, "config/tcb-pins.json"), resolve(stage, "tcb-pins.json"));

const tarName = `inference-engine-runtime-${version}.tar.gz`;
const tarPath = resolve(outDir, tarName);
execFileSync("tar", ["-czf", tarPath, "-C", stage, "."], { stdio: "inherit" });

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const ieRuntimeSha256 = sha256(tarPath);
const sums = [`${ieRuntimeSha256}  ${tarName}`];

let opeFfiSha256 = "";
let attestedMtlsSha256 = "";
const pins = JSON.parse(readFileSync(resolve(root, "config/tcb-pins.json"), "utf8"));

if (includeNatives) {
  execFileSync(process.execPath, [resolve(here, "fetch-ope-ffi.mjs")], {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, TEECHAT_OPE_FFI_OUT: resolve(outDir, "libope_ffi.so") },
  });
  execFileSync(process.execPath, [resolve(here, "fetch-attested-mtls.mjs")], {
    stdio: "inherit",
    cwd: root,
    env: {
      ...process.env,
      TEECHAT_ATTESTED_MTLS_OUT: resolve(outDir, "libattested_mtls.so"),
    },
  });
  opeFfiSha256 = sha256(resolve(outDir, "libope_ffi.so"));
  attestedMtlsSha256 = sha256(resolve(outDir, "libattested_mtls.so"));
  sums.push(`${opeFfiSha256}  libope_ffi.so`);
  sums.push(`${attestedMtlsSha256}  libattested_mtls.so`);
} else {
  opeFfiSha256 = (pins.ope?.libopeFfiSha256 || "").toLowerCase();
  attestedMtlsSha256 = (pins.attestedMtls?.libAttestedMtlsSha256 || "").toLowerCase();
}

writeFileSync(resolve(outDir, "SHA256SUMS"), sums.join("\n") + "\n");

const manifest = {
  schema: "teechat-inference-engine-release/v2",
  version,
  tag: `v${version}`,
  ieRuntimeSha256,
  ieRuntimeAsset: tarName,
  opeFfiSha256,
  opeTag: pins.ope?.tag ?? "",
  opeVersion: pins.ope?.version ?? "",
  opeGitSha: pins.ope?.gitSha ?? "",
  attestedMtlsSha256,
  attestedMtlsTag: pins.attestedMtls?.tag ?? "",
  attestedMtlsVersion: pins.attestedMtls?.version ?? "",
  notes:
    "Primary measured artifact is inference-engine-runtime-*.tar.gz (engine.binary_sha256). " +
    "libope_ffi.so / libattested_mtls.so are independent TCBs (also attached when INCLUDE_NATIVES=1).",
};
writeFileSync(resolve(outDir, "RELEASE_MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");

console.error(`[pack-runtime] ${tarName} sha256=${ieRuntimeSha256.slice(0, 16)}…`);
console.error(`[pack-runtime] wrote ${outDir}/SHA256SUMS + RELEASE_MANIFEST.json`);
