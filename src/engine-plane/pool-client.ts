import http2, { type ClientHttp2Session } from "node:http2";
import { randomUUID } from "node:crypto";

import {
  ENGINE_PLANE_PATH_CONNECT,
  ENGINE_PLANE_PATH_DISCONNECT,
  ENGINE_PLANE_PATH_EPHEMERAL,
  ENGINE_PLANE_PATH_POOL,
  ENGINE_PLANE_PATH_WORK_PULL,
  HEADER_OPE_REQUEST_ID,
  HEADER_OPE_SESSION_ID,
  HEADER_USAGE_REPORT,
  INFERENCE_PATH,
  type AttestedConnectRequest,
  type AttestedDisconnectRequest,
  type AttestedDisconnectResponse,
  type AttestedPoolResizeRequest,
  type EngineEphemeralRegisterRequest,
  type OpeEnvelope,
} from "../protocol/types.js";
import { CONTENT_TYPE_OPE_JSON_STREAM } from "../protocol/ope-stream.js";
import type { GatewayMtlsTlsMaterial } from "../client/gateway-mtls.js";
import {
  verifyPlatformAttestationBundle,
  type AttestationPolicy,
  type PlatformAttestationPolicy,
} from "../attestation.js";
import {
  logEnginePoolConnect,
  logEnginePoolConnectFailed,
  logEngineWorkAssigned,
} from "../ops/engine-events.js";
import { configureEventLogFromEnv } from "../ops/event-log.js";
import { vllmConfigFromEnv } from "../upstream/vllm-chat.js";
import {
  isGatewayPlaneTaskEnvelope,
  runMockInferenceOnEnvelope,
  type MockInferenceOptions,
} from "./inference-handler.js";
import type { OpeNdjsonStreamWriter } from "../server/ope-inference.js";

export const ENGINE_PLANE_PATH_INFERENCE_RESULT = `${INFERENCE_PATH}/result`;

export interface EnginePlanePoolClientOptions {
  gatewayBaseUrl: string;
  tls: GatewayMtlsTlsMaterial;
  connect: AttestedConnectRequest;
  poolTargetSize: number;
  inference?: MockInferenceOptions;
  onError?: (err: Error) => void;
  /** When set, engine verifies gateway platform attestation at connect (SEC-029). */
  gatewayPlatformVerify?: {
    enginePolicy: AttestationPolicy;
    platformPolicy: PlatformAttestationPolicy;
    gatewayBinarySha256: string;
    skillHubBinarySha256: string;
    gatewayEd25519Public: string;
  };
}

export interface EnginePlanePoolClient {
  sessionIds: string[];
  sessions: ClientHttp2Session[];
  close(): Promise<void>;
  setPoolTargetSize(size: number): Promise<void>;
}

function h2RequestJson(
  session: ClientHttp2Session,
  opts: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string | number> = {
      ":method": opts.method,
      ":path": opts.path,
      ...opts.headers,
    };
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }

    const stream = session.request(headers);
    const chunks: Buffer[] = [];
    let status = 0;

    stream.on("response", (responseHeaders) => {
      const raw = responseHeaders[":status"];
      status = typeof raw === "number" ? raw : Number(raw ?? 0);
    });
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      let json: unknown = {};
      if (text) {
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          json = { raw: text };
        }
      }
      resolve({ status, json });
    });
    stream.on("error", reject);
    if (payload !== undefined) {
      stream.end(payload);
    } else {
      stream.end();
    }
  });
}

async function openPooledConnection(
  opts: EnginePlanePoolClientOptions,
  sessionId: string,
): Promise<ClientHttp2Session> {
  const url = new URL(opts.gatewayBaseUrl);
  const session = http2.connect(url.origin, {
    ca: opts.tls.caCertPem,
    cert: opts.tls.clientCertPem,
    key: opts.tls.clientKeyPem,
    rejectUnauthorized: opts.tls.rejectUnauthorized ?? true,
    ALPNProtocols: ["h2"],
    servername: url.hostname,
  });

  await new Promise<void>((resolve, reject) => {
    session.once("error", reject);
    session.once("connect", () => resolve());
  });

  const connectBody: AttestedConnectRequest = {
    ...opts.connect,
    session_id: sessionId,
    pool_target_size: opts.poolTargetSize,
  };

  const connectRes = await h2RequestJson(session, {
    method: "POST",
    path: ENGINE_PLANE_PATH_CONNECT,
    body: connectBody,
  });
  if (connectRes.status !== 200) {
    session.close();
    logEnginePoolConnectFailed(
      connectBody.engine_id,
      opts.gatewayBaseUrl,
      `attested_connect_${connectRes.status}`,
    );
    throw new Error(`attested connect failed: ${connectRes.status} ${JSON.stringify(connectRes.json)}`);
  }

  logEnginePoolConnect(connectBody.engine_id, opts.gatewayBaseUrl, sessionId);

  const verify = opts.gatewayPlatformVerify;
  if (verify) {
    const body = connectRes.json as {
      gateway_attestation?: import("../protocol/types.js").AttestationBundle;
    };
    if (!body.gateway_attestation) {
      session.close();
      throw new Error("gateway_attestation_missing");
    }
    const verdict = verifyPlatformAttestationBundle(
      body.gateway_attestation,
      verify.enginePolicy,
      verify.platformPolicy,
      {
        gatewayBinarySha256: verify.gatewayBinarySha256,
        skillHubBinarySha256: verify.skillHubBinarySha256,
        ed25519Public: verify.gatewayEd25519Public,
      },
    );
    if (!verdict.ok) {
      session.close();
      throw new Error(`gateway_platform_attestation_failed: ${verdict.reason ?? "unknown"}`);
    }
  }

  return session;
}

const DEFAULT_DISCONNECT_TIMEOUT_MS = 120_000;
const DEFAULT_DISCONNECT_POLL_MS = 250;

async function gracefulDisconnectSession(
  session: ClientHttp2Session,
  sessionId: string,
  engineId: string,
  reason: AttestedDisconnectRequest["reason"] = "shutdown",
  timeoutMs = DEFAULT_DISCONNECT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.closed || session.destroyed) return;
    const res = await h2RequestJson(session, {
      method: "POST",
      path: ENGINE_PLANE_PATH_DISCONNECT,
      body: { engine_id: engineId, session_id: sessionId, reason } satisfies AttestedDisconnectRequest,
      headers: { [HEADER_OPE_SESSION_ID]: sessionId },
    }).catch(() => ({ status: 0, json: {} }));
    if (res.status === 200) {
      const body = res.json as AttestedDisconnectResponse;
      if (body.ready_to_close) return;
    }
    await new Promise((r) => setTimeout(r, DEFAULT_DISCONNECT_POLL_MS));
  }
}

function wantsOpeVllmNdjsonStream(envelope: OpeEnvelope, inference: MockInferenceOptions): boolean {
  if (isGatewayPlaneTaskEnvelope(envelope)) return false;
  if (!inference.decryptor) return false;
  if (inference.vllm?.baseUrl) return true;
  if (inference.useEnvVllm === false) return false;
  return Boolean(vllmConfigFromEnv()?.baseUrl);
}

function startPullWorker(
  session: ClientHttp2Session,
  sessionId: string,
  inference: MockInferenceOptions,
  onError?: (err: Error) => void,
): () => void {
  let closed = false;

  const loop = (): void => {
    if (closed || session.closed || session.destroyed) return;

    const pull = session.request({
      ":method": "GET",
      ":path": ENGINE_PLANE_PATH_WORK_PULL,
      [HEADER_OPE_SESSION_ID]: sessionId,
    });

    const workChunks: Buffer[] = [];
    let requestId = "";
    let gotWork = false;

    pull.on("response", (headers) => {
      const status = Number(headers[":status"] ?? 0);
      if (status !== 200) {
        pull.resume();
        return;
      }
      const rid = headers[HEADER_OPE_REQUEST_ID];
      requestId = typeof rid === "string" ? rid : Array.isArray(rid) ? rid[0] ?? "" : "";
    });

    pull.on("data", (chunk) => {
      gotWork = true;
      workChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    pull.on("end", () => {
      if (!gotWork || !requestId) {
        setImmediate(loop);
        return;
      }

      void (async () => {
        const startedAt = Date.now();
        try {
          const envelope = JSON.parse(Buffer.concat(workChunks).toString("utf8")) as OpeEnvelope;
          let resultStream: import("node:http2").ClientHttp2Stream | undefined;
          let openedStreamingResult = false;

          const openInferenceResultStream = (
            contentType: string,
            status: number,
            usageHeader?: string,
          ): import("node:http2").ClientHttp2Stream => {
            resultStream = session.request({
              ":method": "POST",
              ":path": ENGINE_PLANE_PATH_INFERENCE_RESULT,
              [HEADER_OPE_SESSION_ID]: sessionId,
              [HEADER_OPE_REQUEST_ID]: requestId,
              "content-type": contentType,
              "x-ope-status": String(status),
              ...(usageHeader ? { [HEADER_USAGE_REPORT]: usageHeader } : {}),
            });
            return resultStream;
          };

          let ndjsonStream: OpeNdjsonStreamWriter | undefined;
          if (wantsOpeVllmNdjsonStream(envelope, inference)) {
            openInferenceResultStream(CONTENT_TYPE_OPE_JSON_STREAM, 200);
            openedStreamingResult = true;
            ndjsonStream = {
              write: (chunk) => {
                resultStream!.write(chunk);
              },
              end: () => {
                resultStream!.end();
              },
            };
          }

          const { status, contentType, body, usageHeader } = await runMockInferenceOnEnvelope(envelope, {
            ...inference,
            requestId,
            ndjsonStream,
          });
          logEngineWorkAssigned(requestId, Date.now() - startedAt);

          if (contentType === CONTENT_TYPE_OPE_JSON_STREAM) {
            if (usageHeader && resultStream) {
              try {
                const streamWithTrailers = resultStream as import("node:http2").ClientHttp2Stream & {
                  addTrailers?: (trailers: Record<string, string>) => void;
                };
                streamWithTrailers.addTrailers?.({ [HEADER_USAGE_REPORT]: usageHeader });
              } catch {
                /* trailers unsupported — trailer frame in body is authoritative */
              }
            }
          } else {
            if (openedStreamingResult && resultStream && !resultStream.writableEnded) {
              resultStream.destroy();
              resultStream = undefined;
            }
            resultStream = openInferenceResultStream(contentType, status, usageHeader);
            resultStream.end(body);
          }

          if (!resultStream) {
            throw new Error("inference produced no response stream");
          }

          await new Promise<void>((resolve, reject) => {
            if (resultStream!.writableEnded) {
              resolve();
              return;
            }
            resultStream!.on("finish", () => resolve());
            resultStream!.on("error", reject);
          });
        } catch (e) {
          onError?.(e instanceof Error ? e : new Error(String(e)));
        } finally {
          setImmediate(loop);
        }
      })();
    });

    pull.on("error", (err) => {
      onError?.(err instanceof Error ? err : new Error(String(err)));
      if (!closed) setTimeout(loop, 50);
    });
  };

  loop();
  return () => {
    closed = true;
  };
}

/** Engine-side pooled Attested TLS + HTTP/2 client (mock inference worker included). */
export async function createEnginePlanePoolClient(
  opts: EnginePlanePoolClientOptions,
): Promise<EnginePlanePoolClient> {
  configureEventLogFromEnv(process.env);
  const sessionIds: string[] = [];
  const sessions: ClientHttp2Session[] = [];
  const stopWorkers: Array<() => void> = [];
  const inference = opts.inference ?? {};

  for (let i = 0; i < opts.poolTargetSize; i++) {
    const sessionId = randomUUID();
    let session: ClientHttp2Session;
    try {
      session = await openPooledConnection(opts, sessionId);
    } catch (e) {
      logEnginePoolConnectFailed(
        opts.connect.engine_id,
        opts.gatewayBaseUrl,
        e instanceof Error ? e.message : String(e),
      );
      throw e;
    }
    sessionIds.push(sessionId);
    sessions.push(session);
    stopWorkers.push(startPullWorker(session, sessionId, inference, opts.onError));
  }

  return {
    sessionIds,
    sessions,
    close: async (reason: AttestedDisconnectRequest["reason"] = "shutdown") => {
      for (const stop of stopWorkers) stop();
      const engineId = opts.connect.engine_id;
      await Promise.all(
        sessions.map((session, i) =>
          gracefulDisconnectSession(session, sessionIds[i]!, engineId, reason).catch(() => undefined),
        ),
      );
      for (const s of sessions) {
        if (!s.destroyed) s.close();
      }
    },
    setPoolTargetSize: async (size: number) => {
      if (size < 1) throw new Error("pool_target_size must be >= 1");
      if (size === sessions.length) return;

      if (size > sessions.length) {
        const add = size - sessions.length;
        for (let i = 0; i < add; i++) {
          const sessionId = randomUUID();
          const session = await openPooledConnection(
            { ...opts, poolTargetSize: size },
            sessionId,
          );
          sessionIds.push(sessionId);
          sessions.push(session);
          stopWorkers.push(startPullWorker(session, sessionId, inference, opts.onError));
        }
        return;
      }

      const remove = sessions.length - size;
      if (sessions.length > 0) {
        const keepSession = sessions[0]!;
        const keepSessionId = sessionIds[0]!;
        await h2RequestJson(keepSession, {
          method: "POST",
          path: ENGINE_PLANE_PATH_POOL,
          body: { pool_target_size: size } satisfies AttestedPoolResizeRequest,
          headers: { [HEADER_OPE_SESSION_ID]: keepSessionId },
        }).catch(() => undefined);
      }
      for (let i = 0; i < remove; i++) {
        const session = sessions.pop();
        const sessionId = sessionIds.pop();
        const stop = stopWorkers.pop();
        stop?.();
        if (session) {
      if (sessionId) {
            await gracefulDisconnectSession(
              session,
              sessionId,
              opts.connect.engine_id,
              "admin",
            ).catch(() => undefined);
          }
          session.close();
        }
      }
    },
  };
}

export async function postEphemeralOnAttestedSession(opts: {
  session: ClientHttp2Session;
  sessionId: string;
  body: EngineEphemeralRegisterRequest;
}): Promise<{ status: number; json: unknown }> {
  return h2RequestJson(opts.session, {
    method: "POST",
    path: ENGINE_PLANE_PATH_EPHEMERAL,
    body: opts.body,
    headers: { [HEADER_OPE_SESSION_ID]: opts.sessionId },
  });
}

export async function postDisconnectOnAttestedSession(opts: {
  session: ClientHttp2Session;
  sessionId: string;
  engineId: string;
  reason?: AttestedDisconnectRequest["reason"];
}): Promise<{ status: number; json: unknown }> {
  return h2RequestJson(opts.session, {
    method: "POST",
    path: ENGINE_PLANE_PATH_DISCONNECT,
    body: {
      engine_id: opts.engineId,
      session_id: opts.sessionId,
      reason: opts.reason ?? "shutdown",
    } satisfies AttestedDisconnectRequest,
    headers: { [HEADER_OPE_SESSION_ID]: opts.sessionId },
  });
}
