import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

import { buildMockCpuQuote, type MockCpuQuotePayload } from "../attestation.js";
import { bytesToBase64Url } from "../crypto-util.js";
import { ephemeralSigningBytes } from "../ephemeral.js";
import type {
  AttestationBundle,
  AttestedConnectRequest,
  EngineEphemeralRegisterRequest,
  EngineHybridPublic,
  EngineStartupIdentity,
} from "../protocol/types.js";
import { MOCK_MLKEM_ENCAP_B64URL_LEN } from "../protocol/types.js";

export const MOCK_ENGINE_BINARY_SHA256 =
  "a1b2c3d4e5f6789012345678abcdef9012345678abcdef9012345678abcdef90";
export const MOCK_VLLM_BINARY_SHA256 =
  "b2c3d4e5f6789012345678abcdef9012345678abcdef9012345678abcdef9012";

export interface MockEngineRegisterPayload {
  engine_id: string;
  models: string[];
  identity: EngineStartupIdentity;
  attestation: AttestationBundle;
}

export interface MockEngineKeyMaterial {
  engineId: string;
  ed25519Public: string;
  ed25519PrivateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  tlsClientCertSha256: string;
  registerRequest: MockEngineRegisterPayload;
}

export interface MockEphemeralMaterial {
  epochId: string;
  hybrid: EngineHybridPublic;
  ephemeralRequest: EngineEphemeralRegisterRequest;
  notBefore: string;
  notAfter: string;
}

function rawEd25519PublicB64Url(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(-32).toString("base64url");
}

function mockMlkemEncapKey(): string {
  return bytesToBase64Url(randomBytes(Math.ceil((MOCK_MLKEM_ENCAP_B64URL_LEN * 3) / 4))).slice(
    0,
    MOCK_MLKEM_ENCAP_B64URL_LEN,
  );
}

export function buildMockAttestationBundle(args: {
  ed25519Public: string;
  tlsClientCertSha256: string;
  cpuKind?: "tdx" | "sev-snp";
}): AttestationBundle {
  const payload: MockCpuQuotePayload = {
    v: 1,
    kind: args.cpuKind ?? "tdx",
    ed25519_public: args.ed25519Public,
    tls_client_cert_sha256: args.tlsClientCertSha256.toLowerCase(),
    engine: { version: "1.2.0-mock", binary_sha256: MOCK_ENGINE_BINARY_SHA256 },
    vllm: { version: "0.6.2-mock", binary_sha256: MOCK_VLLM_BINARY_SHA256 },
    issued_at: new Date().toISOString(),
  };
  return {
    cpu_tee: {
      kind: payload.kind,
      quote: buildMockCpuQuote(payload),
      verdict: "pass",
      policy_id: "teechat-cpu-tee-v1",
    },
    gpu_tee: {
      kind: "nv-cc",
      evidence: bytesToBase64Url(Buffer.from("mock-gpu-tee-evidence", "utf8")),
      verdict: "pass",
    },
    vllm: payload.vllm,
    engine: payload.engine,
  };
}

export function buildAttestedConnectRequest(args: {
  material: MockEngineKeyMaterial;
  sessionId: string;
  poolTargetSize?: number;
  instanceId?: string;
}): AttestedConnectRequest {
  return {
    session_id: args.sessionId,
    engine_id: args.material.engineId,
    models: args.material.registerRequest.models,
    identity: args.material.registerRequest.identity,
    attestation: args.material.registerRequest.attestation,
    pool_target_size: args.poolTargetSize,
    ...(args.instanceId ? { instance_id: args.instanceId } : {}),
  };
}

/** Simulates in-TEE startup key generation (RAM-only; private key returned for tests only). */
export function generateMockEngineKeys(args: {
  engineId: string;
  models: string[];
  tlsClientCertSha256?: string;
}): MockEngineKeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const ed25519Public = rawEd25519PublicB64Url(publicKey);
  const tlsClientCertSha256 = (args.tlsClientCertSha256 ?? randomBytes(32).toString("hex")).toLowerCase();
  const attestation = buildMockAttestationBundle({ ed25519Public, tlsClientCertSha256 });

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

export function generateMockEphemeralEpoch(args: {
  engineId: string;
  material: MockEngineKeyMaterial;
  epochId?: string;
  ttlMs?: number;
}): MockEphemeralMaterial {
  const now = Date.now();
  const notBefore = new Date(now).toISOString();
  const notAfter = new Date(now + (args.ttlMs ?? 86_400_000)).toISOString();
  const epochId = args.epochId ?? `epoch-${now}`;

  const hybrid: EngineHybridPublic = {
    kex: "X25519MLKEM768",
    mlkem_encapsulation_key: mockMlkemEncapKey(),
    x25519_public: bytesToBase64Url(randomBytes(32)),
  };

  const signingPayload = {
    engineId: args.engineId,
    epochId,
    notAfter,
    hybrid,
  };
  const identity_signature = sign(
    null,
    ephemeralSigningBytes(signingPayload),
    args.material.ed25519PrivateKey,
  ).toString("base64url");

  const ephemeralRequest: EngineEphemeralRegisterRequest = {
    engine_id: args.engineId,
    epoch_id: epochId,
    not_before: notBefore,
    not_after: notAfter,
    hybrid,
    identity_signature,
    attestation: args.material.registerRequest.attestation,
  };

  return { epochId, hybrid, ephemeralRequest, notBefore, notAfter };
}
