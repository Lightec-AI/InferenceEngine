/**
 * Engine ephemeral epoch creation.
 *
 * Generates a fresh hybrid epoch keypair (real ML-KEM-768 + X25519 via the OPE FFI in
 * production, random public material in development mock mode), signs the ephemeral
 * identity with the engine's long-term Ed25519 key, and returns the registration request
 * plus the live engine handle to decrypt requests for the epoch's lifetime.
 */

import { sign, type KeyObject } from "node:crypto";

import { resolveCryptoProvider, type CryptoProvider } from "../crypto/provider.js";
import { ephemeralSigningBytes } from "../ephemeral.js";
import type {
  AttestationBundle,
  EngineEphemeralRegisterRequest,
  EngineHybridPublic,
} from "../protocol/types.js";

export interface EngineEpoch {
  epochId: string;
  hybrid: EngineHybridPublic;
  ephemeralRequest: EngineEphemeralRegisterRequest;
  notBefore: string;
  notAfter: string;
  /** Live engine epoch handle for request decryption; `null` under the mock provider. */
  handle: number | null;
  provider: CryptoProvider;
}

export function createEngineEpoch(args: {
  engineId: string;
  ed25519PublicB64: string;
  ed25519PrivateKey: KeyObject;
  attestation?: AttestationBundle;
  epochId?: string;
  ttlMs?: number;
  provider?: CryptoProvider;
  env?: NodeJS.ProcessEnv;
}): EngineEpoch {
  const provider = args.provider ?? resolveCryptoProvider(args.env);
  const now = Date.now();
  const notBefore = new Date(now).toISOString();
  const notAfter = new Date(now + (args.ttlMs ?? 86_400_000)).toISOString();
  const epochId = args.epochId ?? `epoch-${now}`;

  const { hybrid, handle } = provider.generateEngineHybrid(args.engineId, args.ed25519PublicB64);

  try {
    const identity_signature = sign(
      null,
      ephemeralSigningBytes({ engineId: args.engineId, epochId, notAfter, hybrid }),
      args.ed25519PrivateKey,
    ).toString("base64url");

    const ephemeralRequest: EngineEphemeralRegisterRequest = {
      engine_id: args.engineId,
      epoch_id: epochId,
      not_before: notBefore,
      not_after: notAfter,
      hybrid,
      identity_signature,
      ...(args.attestation ? { attestation: args.attestation } : {}),
    };

    return { epochId, hybrid, ephemeralRequest, notBefore, notAfter, handle, provider };
  } catch (e) {
    // SEC-028: don't leak the native epoch handle if signing/assembly fails.
    if (handle != null) {
      try {
        provider.freeEngine(handle);
      } catch {
        /* best-effort cleanup */
      }
    }
    throw e;
  }
}

/** Release the native epoch handle (call on rotation/shutdown). */
export function disposeEngineEpoch(epoch: EngineEpoch): void {
  if (epoch.handle != null) epoch.provider.freeEngine(epoch.handle);
}
