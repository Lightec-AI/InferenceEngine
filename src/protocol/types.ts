/**
 * Shared OPE inference protocol types (gateway ↔ engine contract).
 * OPE crypto: `vendor/ope` in TeeChat. Gateway registry: TeeChat `server/confidential-ai/`.
 */

export interface EngineStartupIdentity {
  engine_id: string;
  kex: string;
  ed25519_public: string;
}

/** @deprecated Startup identity + ephemeral hybrid; not a single static ML-KEM key. */
export interface EngineIdentity extends EngineStartupIdentity {
  mlkem_encapsulation_key: string;
  x25519_public: string;
}

export interface EngineHybridPublic {
  kex: string;
  mlkem_encapsulation_key: string;
  x25519_public: string;
}

export interface WorkloadMeasurements {
  version: string;
  binary_sha256: string;
}

/** Optional OPE identity (additive; not SNP REPORT_DATA-bound in v1). */
export interface OpeWorkloadIdentity {
  version: string;
  git_sha: string;
  libope_ffi_sha256: string;
}

export interface CpuTeeAttestation {
  kind: "tdx" | "sev-snp";
  quote: string;
  verdict: "pass" | "fail";
  policy_id: string;
}

export interface GpuTeeAttestation {
  kind: "nv-cc" | "amd-gpu-tee";
  evidence: string;
  verdict: "pass" | "fail";
}

export interface AttestationBundle {
  cpu_tee: CpuTeeAttestation;
  gpu_tee: GpuTeeAttestation;
  vllm: WorkloadMeasurements;
  engine: WorkloadMeasurements;
  /** Present on engine trains that pin OPE semver (config/ope-version.json). */
  ope?: OpeWorkloadIdentity;
}

export interface EngineEphemeralRegisterRequest {
  engine_id: string;
  epoch_id: string;
  not_before: string;
  not_after: string;
  hybrid: EngineHybridPublic;
  identity_signature: string;
  attestation?: AttestationBundle;
}

export interface EngineTrustBundle {
  engine_id: string;
  epoch_id: string;
  not_before: string;
  not_after: string;
  hybrid: EngineHybridPublic;
  identity: {
    ed25519_public: string;
    identity_signature: string;
  };
  attestation: AttestationBundle;
  gateway_cached_at: string;
}

export interface OpeE2eDescriptor {
  kex: string;
  client_share?: string;
  engine_mlkem_encap: string;
  engine_x25519: string;
  ephemeral_epoch: string;
  content_alg?: string;
}

export interface UsageReport {
  request_id: string;
  conversation_id: string;
  engine_id: string;
  prompt_tokens: number;
  completion_tokens: number;
  ts: string;
}

export interface SignedUsageReport {
  report: UsageReport;
  sig: string;
}

export interface GatewayPlaneTaskPayload {
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
}

export interface OpeEnvelopeMeta {
  conversation_id?: string;
  model?: string;
  tenant?: string;
  metering?: { units?: number };
  route?: { engine_id?: string };
  /**
   * Work-envelope traffic class (`live_chat` | `api`). Must match
   * {@link HEADER_OPE_TRAFFIC_CLASS} on engine-plane assign.
   */
  traffic_class?: "live_chat" | "api" | string;
  /** Gateway-origin background job (guard rewrite, metrics digest, etc.). */
  gateway_task?: GatewayPlaneTaskPayload;
}

export interface OpeEnvelope {
  ope_version: string;
  alg: string;
  enc: string;
  kid: string;
  recipient: string;
  ts: string;
  nonce: string;
  payload_hash: string;
  engine_id?: string;
  meta?: OpeEnvelopeMeta;
  sig?: string;
  ciphertext?: string;
  iv?: string;
  e2e?: OpeE2eDescriptor | unknown;
}

export const HEADER_ENGINE_CLIENT_CERT = "x-ope-engine-client-cert-sha256";
export const HEADER_USAGE_REPORT = "x-ope-usage-report";
export const HEADER_OPE_GATEWAY_ID = "x-ope-gateway-id";
export const HEADER_OPE_EPHEMERAL_EPOCH = "x-ope-ephemeral-epoch";
export const HEADER_OPE_CONVERSATION_ID = "x-ope-conversation-id";
export const HEADER_OPE_REQUEST_ID = "x-ope-request-id";
export const HEADER_OPE_SESSION_ID = "x-ope-session-id";
/** HTTP/2 work-pull response header (lowercase for Node http2). */
export const HEADER_OPE_TRAFFIC_CLASS = "x-ope-traffic-class";
export const OPE_TRAFFIC_CLASS_LIVE_CHAT = "live_chat" as const;
export const OPE_TRAFFIC_CLASS_API = "api" as const;
export type OpeTrafficClass =
  | typeof OPE_TRAFFIC_CLASS_LIVE_CHAT
  | typeof OPE_TRAFFIC_CLASS_API;
export const DEFAULT_OPE_TRAFFIC_CLASS: OpeTrafficClass = OPE_TRAFFIC_CLASS_LIVE_CHAT;
export const CONTENT_TYPE_OPE_JSON = "application/ope+json";
export const INFERENCE_PATH = "/v1/ope/inference";

export function isOpeTrafficClass(raw: unknown): raw is OpeTrafficClass {
  return raw === OPE_TRAFFIC_CLASS_LIVE_CHAT || raw === OPE_TRAFFIC_CLASS_API;
}

export function parseOpeTrafficClass(raw: unknown): OpeTrafficClass | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return isOpeTrafficClass(normalized) ? normalized : null;
}

/** Unknown/missing → `live_chat`. Never invents `api`. */
export function resolveOpeTrafficClass(raw: unknown): OpeTrafficClass {
  return parseOpeTrafficClass(raw) ?? DEFAULT_OPE_TRAFFIC_CLASS;
}

export function opeTrafficClassQosRank(trafficClass: OpeTrafficClass): number {
  return trafficClass === OPE_TRAFFIC_CLASS_LIVE_CHAT ? 0 : 1;
}

export function shouldMeterSubscriptionUsage(trafficClass: OpeTrafficClass): boolean {
  return trafficClass === OPE_TRAFFIC_CLASS_LIVE_CHAT;
}

export function trafficClassHeaderMetaConsistent(
  headerRaw: unknown,
  metaRaw: unknown,
): { ok: true; trafficClass: OpeTrafficClass } | { ok: false; reason: string } {
  const fromHeader = parseOpeTrafficClass(headerRaw);
  const fromMeta = parseOpeTrafficClass(metaRaw);
  if (fromHeader && fromMeta && fromHeader !== fromMeta) {
    return {
      ok: false,
      reason: `traffic_class mismatch: header=${fromHeader} meta=${fromMeta}`,
    };
  }
  const trafficClass = fromHeader ?? fromMeta;
  if (!trafficClass) {
    return { ok: false, reason: "traffic_class missing" };
  }
  return { ok: true, trafficClass };
}

/** Attested engine plane (HTTP/2 on TLS). */
export const ENGINE_PLANE_PATH_CONNECT = "/v1/ope/control/connect";
export const ENGINE_PLANE_PATH_DISCONNECT = "/v1/ope/control/disconnect";
export const ENGINE_PLANE_PATH_EPHEMERAL = "/v1/ope/control/ephemeral";
export const ENGINE_PLANE_PATH_POOL = "/v1/ope/control/pool";
export const ENGINE_PLANE_PATH_WORK_PULL = "/v1/ope/work/pull";

export interface AttestedConnectRequest {
  session_id: string;
  engine_id: string;
  models: string[];
  identity: EngineStartupIdentity;
  attestation: AttestationBundle;
  /** Desired pool width reported by engine supervisor. */
  pool_target_size?: number;
  /**
   * Blue/green (or other) process instance under the same `engine_id`.
   * Each instance has its own startup identity; gateway must not overwrite
   * one instance's identity with another's during cutover overlap.
   * Omitted → `"default"` (single-process deploys).
   */
  instance_id?: string;
  /**
   * Engine-issued 128-bit hex challenge; gateway binds into platform quote.
   * Reused across parallel connects in one boot or scale batch.
   */
  gateway_challenge_nonce?: string;
}

export interface AttestedConnectResponse {
  ok: boolean;
  gateway_attestation?: AttestationBundle;
  pool_target_ack?: number;
  /** Echo of {@link AttestedConnectRequest.gateway_challenge_nonce} when challenged. */
  gateway_challenge_nonce?: string;
}

export interface AttestedPoolResizeRequest {
  pool_target_size: number;
}

/** Graceful engine session logout before closing the Attested TLS connection. */
export interface AttestedDisconnectRequest {
  engine_id: string;
  session_id: string;
  reason?: "shutdown" | "upgrade" | "admin";
}

export interface AttestedDisconnectResponse {
  ok: boolean;
  draining: boolean;
  in_flight: number;
  /** Engine may close the HTTP/2 session when true. */
  ready_to_close: boolean;
  /** Set when this was the last live session and the engine row was removed. */
  engine_deregistered?: boolean;
}

export const MOCK_MLKEM_ENCAP_B64URL_LEN = 1184;
