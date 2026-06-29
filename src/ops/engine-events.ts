import { logEvent, parseGatewayHost } from "./event-log.js";

export function logEnginePoolConnect(engineId: string, gatewayBaseUrl: string, sessionId: string): void {
  logEvent("info", "inference.engine", "pool_connect_success", {
    engineId,
    gatewayHost: parseGatewayHost(gatewayBaseUrl),
    sessionId,
  });
}

export function logEnginePoolConnectFailed(
  engineId: string,
  gatewayBaseUrl: string,
  reason: string,
): void {
  logEvent("warn", "inference.engine", "pool_connect_failed", {
    engineId,
    gatewayHost: parseGatewayHost(gatewayBaseUrl),
    reason: reason.slice(0, 200),
  });
}

export function logEngineWorkAssigned(requestId: string, latencyMs: number): void {
  logEvent("debug", "inference.engine", "work_assigned", {
    requestId,
    latencyMs,
  });
}

export function logEngineVllmUpstreamError(requestId: string | undefined, httpStatus: number | undefined, err: unknown): void {
  logEvent("error", "inference.engine", "vllm_upstream_failed", {
    requestId,
    httpStatus,
    error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
  });
}

export function logEngineEphemeralRegisterFailed(engineId: string, status: number): void {
  logEvent("warn", "inference.engine", "ephemeral_register_failed", {
    engineId,
    status,
  });
}

export function logEngineEpochRotateSuccess(
  engineId: string,
  epochId: string,
  notAfter: string,
): void {
  logEvent("info", "inference.engine", "epoch_rotate_success", {
    engineId,
    epochId,
    notAfter,
  });
}

export function logEngineEpochRotateFailed(
  engineId: string,
  status: number,
  detail: string,
): void {
  logEvent("warn", "inference.engine", "epoch_rotate_failed", {
    engineId,
    status,
    detail: detail.slice(0, 200),
  });
}

export function logEngineSessionReconnect(
  engineId: string,
  sessionId: string,
  attempt: number,
): void {
  logEvent("info", "inference.engine", "pool_session_reconnect", {
    engineId,
    sessionId,
    attempt,
  });
}

export function logEnginePoolDrain(
  engineId: string,
  drained: number,
  remaining: number,
  blocked: boolean,
): void {
  logEvent("info", "inference.engine", "pool_drain", {
    engineId,
    drained,
    remaining,
    blocked,
  });
}

export function logEnginePoolScale(engineId: string, added: number, total: number): void {
  logEvent("info", "inference.engine", "pool_scale", {
    engineId,
    added,
    total,
  });
}

export function logEngineShutdown(engineId: string, buildId?: string): void {
  logEvent("info", "inference.engine", "shutdown", {
    engineId,
    buildId,
  });
}
