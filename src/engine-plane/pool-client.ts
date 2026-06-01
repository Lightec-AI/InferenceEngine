import http2, { type ClientHttp2Session } from "node:http2";
import { randomUUID } from "node:crypto";

import {
  ENGINE_PLANE_PATH_CONNECT,
  ENGINE_PLANE_PATH_EPHEMERAL,
  ENGINE_PLANE_PATH_POOL,
  ENGINE_PLANE_PATH_WORK_PULL,
  HEADER_OPE_REQUEST_ID,
  HEADER_OPE_SESSION_ID,
  HEADER_USAGE_REPORT,
  INFERENCE_PATH,
  type AttestedConnectRequest,
  type AttestedPoolResizeRequest,
  type EngineEphemeralRegisterRequest,
  type OpeEnvelope,
} from "../protocol/types.js";
import type { GatewayMtlsTlsMaterial } from "../client/gateway-mtls.js";
import { runMockInferenceOnEnvelope, type MockInferenceOptions } from "./inference-handler.js";

export const ENGINE_PLANE_PATH_INFERENCE_RESULT = `${INFERENCE_PATH}/result`;

export interface EnginePlanePoolClientOptions {
  gatewayBaseUrl: string;
  tls: GatewayMtlsTlsMaterial;
  connect: AttestedConnectRequest;
  poolTargetSize: number;
  inference?: MockInferenceOptions;
  onError?: (err: Error) => void;
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
    throw new Error(`attested connect failed: ${connectRes.status} ${JSON.stringify(connectRes.json)}`);
  }
  return session;
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
        try {
          const envelope = JSON.parse(Buffer.concat(workChunks).toString("utf8")) as OpeEnvelope;
          const { status, contentType, body, usageHeader } = await runMockInferenceOnEnvelope(
            envelope,
            inference,
          );

          const resultStream = session.request({
            ":method": "POST",
            ":path": ENGINE_PLANE_PATH_INFERENCE_RESULT,
            [HEADER_OPE_SESSION_ID]: sessionId,
            [HEADER_OPE_REQUEST_ID]: requestId,
            "content-type": contentType,
            "x-ope-status": String(status),
            ...(usageHeader ? { [HEADER_USAGE_REPORT]: usageHeader } : {}),
          });

          resultStream.end(body);
          await new Promise<void>((resolve, reject) => {
            resultStream.on("end", () => resolve());
            resultStream.on("error", reject);
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
  const sessionIds: string[] = [];
  const sessions: ClientHttp2Session[] = [];
  const stopWorkers: Array<() => void> = [];
  const inference = opts.inference ?? {};

  for (let i = 0; i < opts.poolTargetSize; i++) {
    const sessionId = randomUUID();
    const session = await openPooledConnection(opts, sessionId);
    sessionIds.push(sessionId);
    sessions.push(session);
    stopWorkers.push(startPullWorker(session, sessionId, inference, opts.onError));
  }

  return {
    sessionIds,
    sessions,
    close: async () => {
      for (const stop of stopWorkers) stop();
      for (const s of sessions) {
        if (!s.destroyed) s.destroy();
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
      for (let i = 0; i < remove; i++) {
        const session = sessions.pop();
        const sessionId = sessionIds.pop();
        const stop = stopWorkers.pop();
        stop?.();
        if (session) {
          if (sessionId) {
            await h2RequestJson(session, {
              method: "POST",
              path: ENGINE_PLANE_PATH_POOL,
              body: { pool_target_size: size } satisfies AttestedPoolResizeRequest,
              headers: { [HEADER_OPE_SESSION_ID]: sessionId },
            }).catch(() => undefined);
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
