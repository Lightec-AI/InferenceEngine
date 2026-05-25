import { verify } from "node:crypto";

import type { EngineEphemeralRegisterRequest, EngineHybridPublic } from "./protocol/types.js";
import { ed25519PublicKeyFromBase64Url } from "./crypto-util.js";

/** Canonical bytes for `identity_signature` over an ephemeral epoch (OPE-ENGINE-EPHEMERAL-v1). */
export function ephemeralSigningBytes(args: {
  engineId: string;
  epochId: string;
  notAfter: string;
  hybrid: EngineHybridPublic;
}): Buffer {
  const parts = [
    "OPE-ENGINE-EPHEMERAL-v1",
    args.engineId,
    args.epochId,
    args.notAfter,
    args.hybrid.mlkem_encapsulation_key,
    args.hybrid.x25519_public,
  ];
  return Buffer.from(parts.join("\0"), "utf8");
}

export function verifyEphemeralIdentitySignature(
  ed25519PublicBase64Url: string,
  req: Pick<EngineEphemeralRegisterRequest, "engine_id" | "epoch_id" | "not_after" | "hybrid" | "identity_signature">,
): boolean {
  const msg = ephemeralSigningBytes({
    engineId: req.engine_id,
    epochId: req.epoch_id,
    notAfter: req.not_after,
    hybrid: req.hybrid,
  });
  const sig = Buffer.from(req.identity_signature, "base64url");
  if (sig.length !== 64) return false;
  const key = ed25519PublicKeyFromBase64Url(ed25519PublicBase64Url);
  return verify(null, msg, key, sig);
}

export function parseIsoTime(s: string): number {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error("invalid_iso_time");
  return t;
}

export function isEpochActive(notBefore: string, notAfter: string, nowMs = Date.now()): boolean {
  const start = parseIsoTime(notBefore);
  const end = parseIsoTime(notAfter);
  return nowMs >= start && nowMs <= end;
}
