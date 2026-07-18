#!/usr/bin/env node
/**
 * Download measured libattested_mtls.so from teechat-attested-mtls GitHub Release
 * (config/tcb-pins.json). Place under ./native/ for ATTESTED_MTLS_LIB_PATH / node loader.
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
const amt = pins.attestedMtls ?? {};

const expectSha = (
  process.env.TEECHAT_EXPECT_ATTESTED_MTLS_SHA256?.trim() ||
  amt.libAttestedMtlsSha256 ||
  ""
).toLowerCase();
const url =
  process.env.TEECHAT_ATTESTED_MTLS_URL?.trim() ||
  amt.assetUrl ||
  (amt.tag
    ? `https://github.com/Lightec-AI/teechat-attested-mtls/releases/download/${amt.tag}/libattested_mtls.so`
    : "");
const out = resolve(
  process.env.TEECHAT_ATTESTED_MTLS_OUT?.trim() ||
    resolve(root, "native/libattested_mtls.so"),
);

if (!url) {
  console.error("[fetch-attested-mtls] no asset URL");
  process.exit(1);
}
if (!/^[0-9a-f]{64}$/.test(expectSha)) {
  console.error("[fetch-attested-mtls] missing/invalid libAttestedMtlsSha256 pin");
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
console.error(`[fetch-attested-mtls] GET ${url}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok || !res.body) {
  console.error(`[fetch-attested-mtls] HTTP ${res.status}`);
  process.exit(1);
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(out));

const got = createHash("sha256").update(readFileSync(out)).digest("hex");
if (got !== expectSha) {
  console.error(`[fetch-attested-mtls] digest mismatch\n  got:  ${got}\n  want: ${expectSha}`);
  process.exit(1);
}
console.error(`[fetch-attested-mtls] ok ${got.slice(0, 16)}… → ${out}`);
if (!existsSync(out)) process.exit(1);
