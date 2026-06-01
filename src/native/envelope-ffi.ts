/**
 * OPE envelope sign/verify helpers (gateway opaque mode).
 */

import type { OpeFfi } from "./ope-ffi.js";
import { loadOpeFfi, OpeFfiError, requireOpeFfi } from "./ope-ffi.js";

/** `ope-crypto` dev vector 001 verifying key (`spec/vectors/001-valid-plaintext.json`). */
export const DEV_VECTOR_001_PUBLIC_KEY_HEX =
  "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";

/** Dev vector-001 secret seed (32 bytes of 0x01). */
export const DEV_VECTOR_001_SECRET_SEED = Buffer.alloc(32, 0x01);

export function devVector001PublicKey(): Buffer {
  return Buffer.from(DEV_VECTOR_001_PUBLIC_KEY_HEX, "hex");
}

export function signEnvelopeWithSecretKey(
  secretKey32: Buffer,
  envelope: Record<string, unknown>,
  ffi: OpeFfi = requireOpeFfi(),
): string {
  if (secretKey32.length !== 32) throw new OpeFfiError("secret key must be 32 bytes");
  return ffi.envelopeSignAlloc(secretKey32, JSON.stringify(envelope));
}

export function verifyGatewayOpaqueEnvelope(
  publicKey32: Buffer,
  envelope: Record<string, unknown>,
  opts: { recipient?: string; maxSkewSecs?: number } = {},
  ffi: OpeFfi = requireOpeFfi(),
): void {
  if (publicKey32.length !== 32) throw new OpeFfiError("public key must be 32 bytes");
  ffi.envelopeVerifyGatewayOpaque(
    publicKey32,
    JSON.stringify(envelope),
    opts.recipient ?? null,
    opts.maxSkewSecs ?? 300,
  );
}

export { loadOpeFfi, OpeFfiError };
