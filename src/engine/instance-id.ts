/**
 * Normalize engine process instance id (blue/green slot under one engine_id).
 * Empty / missing → "default" for single-process deploys.
 */
export const DEFAULT_ENGINE_INSTANCE_ID = "default";

const INSTANCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function normalizeEngineInstanceId(raw?: string | null): string {
  const v = (raw ?? "").trim();
  if (!v) return DEFAULT_ENGINE_INSTANCE_ID;
  if (!INSTANCE_ID_RE.test(v)) {
    throw new Error(`invalid_instance_id:${v}`);
  }
  return v;
}

/** Prefer TEECHAT_ENGINE_INSTANCE_ID, else TEECHAT_ENGINE_SLOT (blue|green). */
export function engineInstanceIdFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TEECHAT_ENGINE_INSTANCE_ID?.trim();
  if (explicit) return normalizeEngineInstanceId(explicit);
  const slot = env.TEECHAT_ENGINE_SLOT?.trim();
  if (slot === "blue" || slot === "green") return slot;
  return DEFAULT_ENGINE_INSTANCE_ID;
}
