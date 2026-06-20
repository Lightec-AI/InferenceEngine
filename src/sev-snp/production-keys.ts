import { generateKeyPairSync } from "node:crypto";

import type {
  AttestedConnectRequest,
  EngineEphemeralRegisterRequest,
  EngineHybridPublic,
  EngineStartupIdentity,
} from "../protocol/types.js";
import type { MockEngineKeyMaterial, MockEngineRegisterPayload } from "../testing/mock-keys.js";
import { buildSevSnpAttestationBundle } from "./build-attestation.js";

function rawEd25519PublicB64Url(
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"],
): string {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(-32).toString("base64url");
}

/** In-TEE startup key generation with real AMD SEV-SNP attestation report. */
export function generateSevSnpEngineKeys(args: {
  engineId: string;
  models: string[];
  tlsClientCertSha256?: string;
  env?: NodeJS.ProcessEnv;
  root?: string;
}): MockEngineKeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const ed25519Public = rawEd25519PublicB64Url(publicKey);
  const tlsClientCertSha256 = (args.tlsClientCertSha256 ?? "").trim().toLowerCase();
  const attestation = buildSevSnpAttestationBundle({
    ed25519Public,
    tlsClientCertSha256,
    env: args.env,
    root: args.root,
  });

  const registerRequest: MockEngineRegisterPayload = {
    engine_id: args.engineId,
    models: args.models,
    identity: {
      engine_id: args.engineId,
      kex: "X25519MLKEM768",
      ed25519_public: ed25519Public,
    },
    attestation,
  };

  return {
    engineId: args.engineId,
    ed25519Public,
    ed25519PrivateKey: privateKey,
    tlsClientCertSha256,
    registerRequest,
  };
}

export function buildSevSnpAttestedConnectRequest(args: {
  material: MockEngineKeyMaterial;
  sessionId: string;
  poolTargetSize?: number;
}): AttestedConnectRequest {
  return {
    session_id: args.sessionId,
    engine_id: args.material.engineId,
    models: args.material.registerRequest.models,
    identity: args.material.registerRequest.identity,
    attestation: args.material.registerRequest.attestation,
    pool_target_size: args.poolTargetSize,
  };
}

export type { EngineEphemeralRegisterRequest, EngineHybridPublic, EngineStartupIdentity };
