import type { AttestationBundle } from "../protocol/types.js";
import { buildSevSnpAttestationBundle } from "../sev-snp/build-attestation.js";
import { shouldUseSevSnpAttestation } from "../sev-snp/guest-report.js";
import { buildMockAttestationBundle } from "../testing/mock-keys.js";

export interface EngineAttestationRefreshContext {
  ed25519Public: string;
  tlsClientCertSha256: string;
  useSevSnp?: boolean;
  env?: NodeJS.ProcessEnv;
  root?: string;
}

/** Mint a fresh CPU/GPU attestation bundle (new SNP report or mock quote). */
export function createEngineAttestationRefresher(
  ctx: EngineAttestationRefreshContext,
): () => AttestationBundle {
  const env = ctx.env ?? process.env;
  const useSevSnp = ctx.useSevSnp ?? shouldUseSevSnpAttestation(env);
  const tlsHash = ctx.tlsClientCertSha256.toLowerCase();

  return () => {
    if (useSevSnp) {
      return buildSevSnpAttestationBundle({
        ed25519Public: ctx.ed25519Public,
        tlsClientCertSha256: tlsHash,
        env,
        root: ctx.root,
      });
    }
    return buildMockAttestationBundle({
      ed25519Public: ctx.ed25519Public,
      tlsClientCertSha256: tlsHash,
    });
  };
}
