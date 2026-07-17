import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Loads `.env`, optional `.env.staging`, then `.env.local` (does not override existing vars). */
export function loadEngineEnvFiles(cwd = process.cwd()): void {
  const staging =
    process.env.TEECHAT_ENV?.trim().toLowerCase() === "staging" ||
    existsSync(resolve(cwd, ".env.staging"));
  const files = staging
    ? [".env", ".env.staging", ".env.local"]
    : [".env", ".env.local"];
  for (const name of files) {
    loadEnvFile(resolve(cwd, name));
  }
}
