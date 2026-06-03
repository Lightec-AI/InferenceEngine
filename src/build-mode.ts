/**
 * Build-mode gate: distinguishes development/debug from production builds at the
 * source level. Mock cryptography and mock attestation are permitted **only** in
 * development; production must use the real OPE FFI and real attestation, failing
 * closed otherwise.
 */

export type BuildMode = "development" | "production";

/** Resolve the effective build mode from the environment. */
export function resolveBuildMode(env: NodeJS.ProcessEnv = process.env): BuildMode {
  const explicit = (env.TEECHAT_BUILD ?? "").trim().toLowerCase();
  if (explicit === "production" || explicit === "prod") return "production";
  if (
    explicit === "development" ||
    explicit === "dev" ||
    explicit === "debug" ||
    explicit === "test"
  ) {
    return "development";
  }
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "production") return "production";
  return "development";
}

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveBuildMode(env) === "production";
}

/** Pre-TDX / Mac Studio staging: production gateway profile with fixture attestation. */
export function isStagingCanary(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.TEECHAT_ENV ?? "").trim().toLowerCase() === "staging") return true;
  return (env.TEECHAT_ATTESTATION_BACKEND ?? "").trim().toLowerCase() === "fixture";
}

/** SEC-026: real production deploys must pin an absolute, hashed library path. */
export function requiresVettedFfiLibrary(env: NodeJS.ProcessEnv = process.env): boolean {
  return isProduction(env) && !isStagingCanary(env);
}

/**
 * Whether mock key material / mock attestation may be used.
 *
 * - Production: never.
 * - Development: yes, unless `TEECHAT_FORCE_REAL_CRYPTO=1` is set (used to exercise
 *   the real path in dev/CI).
 */
export function mockAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isProduction(env)) return false;
  if ((env.TEECHAT_FORCE_REAL_CRYPTO ?? "").trim() === "1") return false;
  return true;
}

/** Throw if a mock is about to be used where it is not permitted. */
export function assertMockAllowed(what: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!mockAllowed(env)) {
    throw new Error(
      `mock ${what} is not permitted in this build (mode=${resolveBuildMode(env)}). ` +
        `Use the real OPE FFI implementation.`,
    );
  }
}
