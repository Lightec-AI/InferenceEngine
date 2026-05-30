import type { AttestationPolicy } from "./attestation.js";
import { verifyAttestationBundle } from "./attestation.js";
import { isEpochActive, verifyEphemeralIdentitySignature } from "./ephemeral.js";
import type { EngineTrustBundle } from "./protocol/types.js";

export interface ClientTrustVerifyResult {
  ok: boolean;
  reason?: string;
}

export interface VerifyEngineTrustBundleOptions {
  /** Attested TLS engines — identity from quote ed25519, not mTLS cert hash. */
  skipTlsCertBinding?: boolean;
}

/** Client-side verification (uses same rules as gateway; for tests and future app). */
export function verifyEngineTrustBundle(
  bundle: EngineTrustBundle,
  policy: AttestationPolicy,
  tlsClientCertSha256: string,
  nowMs = Date.now(),
  opts: VerifyEngineTrustBundleOptions = {},
): ClientTrustVerifyResult {
  const attest = verifyAttestationBundle(
    bundle.attestation,
    policy,
    {
      ed25519Public: bundle.identity.ed25519_public,
      tlsClientCertSha256,
    },
    nowMs,
    undefined,
    { skipTlsCertBinding: opts.skipTlsCertBinding },
  );
  if (!attest.ok) return { ok: false, reason: attest.reason };

  if (!isEpochActive(bundle.not_before, bundle.not_after, nowMs)) {
    return { ok: false, reason: "epoch_expired" };
  }

  const sigOk = verifyEphemeralIdentitySignature(bundle.identity.ed25519_public, {
    engine_id: bundle.engine_id,
    epoch_id: bundle.epoch_id,
    not_after: bundle.not_after,
    hybrid: bundle.hybrid,
    identity_signature: bundle.identity.identity_signature,
  });
  if (!sigOk) return { ok: false, reason: "invalid_identity_signature" };

  return { ok: true };
}
