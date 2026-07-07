/**
 * Production engine plane: resilient attested TLS pool + automatic epoch rotation (T-4).
 */

import { randomUUID } from "node:crypto";
import type { ClientHttp2Session } from "node:http2";
import type { KeyObject } from "node:crypto";

import type { AttestationBundle, AttestedDisconnectRequest } from "../protocol/types.js";
import type { CryptoProvider } from "../crypto/provider.js";
import {
  openPooledConnection,
  postEphemeralOnAttestedSession,
  startPullWorker,
  gracefulDisconnectAttestedSession,
  type EnginePlanePoolClientOptions,
} from "../engine-plane/pool-client.js";
import type { MockInferenceOptions } from "../engine-plane/inference-handler.js";
import { configureEventLogFromEnv } from "../ops/event-log.js";
import {
  logEngineEphemeralRegisterFailed,
  logEnginePoolConnectFailed,
  logEngineSessionReconnect,
} from "../ops/engine-events.js";
import { createEngineSupervisor } from "./supervisor.js";
import { createEpochRotator, type EpochRotator } from "./epoch-rotator.js";
import { createRotatingEpochDecryptor, type RotatingEpochDecryptor } from "./rotating-decryptor.js";
import type { EngineEpoch } from "./epoch.js";
import { epochRotationPolicyFromEnv } from "./supervisor.js";
import {
  createEngineAttestationRefresher,
  type EngineAttestationRefreshContext,
} from "./attestation-refresh.js";
import { planGatewayMigration } from "./gateway-migration.js";
import {
  createPoolConnectThrottleFromEnv,
  initialPoolSessionCount,
  mapWithConcurrency,
  planPoolDrain,
  planPoolScale,
  poolConnectConcurrencyFromEnv,
  poolInitialFractionFromEnv,
} from "./pool-cutover.js";
import { logEnginePoolScale } from "../ops/engine-events.js";
import { generateGatewayConnectChallengeNonce } from "./gateway-connect-nonce.js";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PRUNE_INTERVAL_MS = 60_000;

function poolReconnectCoordinationFromEnv(env: NodeJS.ProcessEnv = process.env): {
  failThreshold: number;
  failWindowMs: number;
  circuitMs: number;
} {
  const failThreshold = Math.max(
    1,
    Math.floor(Number(env.TEECHAT_ENGINE_POOL_RECONNECT_FAIL_THRESHOLD ?? "8") || 8),
  );
  const failWindowMs = Math.max(
    1_000,
    Math.floor(Number(env.TEECHAT_ENGINE_POOL_RECONNECT_FAIL_WINDOW_MS ?? "10000") || 10_000),
  );
  const circuitMs = Math.max(
    1_000,
    Math.floor(Number(env.TEECHAT_ENGINE_POOL_RECONNECT_CIRCUIT_MS ?? "30000") || 30_000),
  );
  return { failThreshold, failWindowMs, circuitMs };
}

function noopPullWorker(): SessionSlot["pullWorker"] {
  return { stop: () => undefined, isBusy: () => false };
}

export interface SupervisedEnginePlanePoolOptions extends EnginePlanePoolClientOptions {
  ed25519PublicB64: string;
  ed25519PrivateKey: KeyObject;
  attestation?: AttestationBundle;
  provider: CryptoProvider;
  /** When false, behaves like legacy pool (no rotation/reconnect). Default true. */
  supervised?: boolean;
  /** TLS client cert hash for attestation binding; enables fresh quotes on reconnect. */
  tlsClientCertSha256?: string;
  /** Override reconnect attestation refresh (defaults from tlsClientCertSha256). */
  refreshAttestation?: () => AttestationBundle;
  attestationRefresh?: Pick<EngineAttestationRefreshContext, "useSevSnp" | "env" | "root">;
  /**
   * Fraction of poolTargetSize to open on boot (default 1). Use 0.5 for green staging slot
   * during in-place engine blue/green — remainder via scalePool().
   */
  poolInitialFraction?: number;
}

export interface GatewayMigrationResult {
  moved: number;
  onTarget: number;
  onSource: number;
  targetCount: number;
  blocked: boolean;
  reason?: string;
}

export interface PoolDrainResult {
  drained: number;
  remaining: number;
  targetRemaining: number;
  blocked: boolean;
  reason?: string;
}

export interface PoolScaleResult {
  added: number;
  total: number;
  targetSize: number;
  blocked: boolean;
  reason?: string;
}

export function sessionsByGatewayUrlFromSlots(
  slots: ReadonlyArray<{ gatewayBaseUrl: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const slot of slots) {
    const url = slot.gatewayBaseUrl.trim();
    if (!url) continue;
    counts[url] = (counts[url] ?? 0) + 1;
  }
  return counts;
}

export interface SupervisedEnginePlanePool {
  sessionIds: string[];
  sessions: ClientHttp2Session[];
  decryptor: RotatingEpochDecryptor;
  rotator: EpochRotator;
  currentEpoch(): EngineEpoch;
  /** Live pool sessions grouped by gateway engine-plane dial URL (ops cutover drain gate). */
  sessionsByGatewayUrl(): Record<string, number>;
  /** Idle-first make-before-break migration to another gateway engine plane URL. */
  migrateGatewayPool(targetUrl: string, fraction: number): Promise<GatewayMigrationResult>;
  /** Idle-first disconnect and remove sessions (blue slot during engine blue/green). */
  drainIdlePool(fraction: number): Promise<PoolDrainResult>;
  /** Open additional attested sessions up to targetSize (green slot completion). */
  scalePool(targetSize: number): Promise<PoolScaleResult>;
  close(reason?: AttestedDisconnectRequest["reason"]): Promise<void>;
}

interface SessionSlot {
  sessionId: string;
  session: ClientHttp2Session;
  gatewayBaseUrl: string;
  pullWorker: { stop: () => void; isBusy: () => boolean };
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  onClose: () => void;
}

function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5));
}

/** Open pool with epoch rotation and per-session reconnect on attested TLS failure. */
export async function createSupervisedEnginePlanePool(
  opts: SupervisedEnginePlanePoolOptions,
): Promise<SupervisedEnginePlanePool> {
  configureEventLogFromEnv(process.env);

  if (opts.supervised === false) {
    throw new Error("supervised=false is not supported; use createEnginePlanePoolClient");
  }

  const engineId = opts.connect.engine_id;
  const primaryGatewayUrl = opts.gatewayBaseUrl;
  const policy = epochRotationPolicyFromEnv();
  const slots: SessionSlot[] = [];
  let closed = false;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  let connect = opts.connect;
  const reconnectCoord = poolReconnectCoordinationFromEnv();
  const poolReconnectFailureTimes: number[] = [];
  let poolReconnectCircuitOpenUntil = 0;
  /** Shared across boot / scale / migrate / reconnect — prevents gateway TLS/event-loop storms. */
  const connectThrottle = createPoolConnectThrottleFromEnv(
    process.env,
    opts.poolTargetSize,
  );
  const openConnection = (
    ...args: Parameters<typeof openPooledConnection>
  ): ReturnType<typeof openPooledConnection> =>
    connectThrottle.run(() => openPooledConnection(...args));

  const recordPoolReconnectFailure = (): void => {
    const now = Date.now();
    const cutoff = now - reconnectCoord.failWindowMs;
    while (poolReconnectFailureTimes.length && poolReconnectFailureTimes[0]! < cutoff) {
      poolReconnectFailureTimes.shift();
    }
    poolReconnectFailureTimes.push(now);
    if (poolReconnectFailureTimes.length >= reconnectCoord.failThreshold) {
      poolReconnectCircuitOpenUntil = now + reconnectCoord.circuitMs;
      poolReconnectFailureTimes.length = 0;
    }
  };

  const clearPoolReconnectCircuit = (): void => {
    poolReconnectFailureTimes.length = 0;
    poolReconnectCircuitOpenUntil = 0;
  };

  const poolReconnectCircuitDelayMs = (now = Date.now()): number =>
    Math.max(0, poolReconnectCircuitOpenUntil - now);

  const refreshAttestation =
    opts.refreshAttestation ??
    (opts.tlsClientCertSha256
      ? createEngineAttestationRefresher({
          ed25519Public: opts.ed25519PublicB64,
          tlsClientCertSha256: opts.tlsClientCertSha256,
          useSevSnp: opts.attestationRefresh?.useSevSnp,
          env: opts.attestationRefresh?.env,
          root: opts.attestationRefresh?.root,
        })
      : undefined);

  const listSessions = () =>
    slots
      .filter((s) => !s.session.closed && !s.session.destroyed)
      .map((s) => ({ session: s.session, sessionId: s.sessionId }));

  let decryptor: RotatingEpochDecryptor;

  const rotator = createEpochRotator({
    engineId,
    ed25519PublicB64: opts.ed25519PublicB64,
    ed25519PrivateKey: opts.ed25519PrivateKey,
    attestation: opts.attestation ?? opts.connect.attestation,
    provider: opts.provider,
    listSessions,
    onEpochRotated: (epoch) => {
      decryptor.addEpoch(epoch);
    },
  });

  const applyFreshAttestation = (): void => {
    if (!refreshAttestation) return;
    const fresh = refreshAttestation();
    connect = { ...connect, attestation: fresh };
    rotator.setAttestation(fresh);
  };

  const poolConnectOpts = (
    gatewayBaseUrl: string = primaryGatewayUrl,
    gatewayChallengeNonce?: string,
  ): EnginePlanePoolClientOptions => ({
    ...opts,
    gatewayBaseUrl,
    connect,
    gatewayChallengeNonce,
  });

  const connectChallengeForBatch = (): string | undefined =>
    opts.gatewayPlatformVerify ? generateGatewayConnectChallengeNonce() : undefined;

  decryptor = createRotatingEpochDecryptor(rotator.currentEpoch(), policy.overlapGraceMs);

  const inference: MockInferenceOptions = {
    ...(opts.inference ?? {}),
    decryptor,
  };

  const supervisor = createEngineSupervisor({
    engineId,
    policy,
    onHealthTick: (_id, healthy) => {
      if (!healthy && !closed) {
        /* reconnect loops continue in background */
      }
    },
  });

  const registerEpochOnSession = async (
    session: ClientHttp2Session,
    sessionId: string,
  ): Promise<void> => {
    const body = rotator.currentEpoch().ephemeralRequest;
    const res = await postEphemeralOnAttestedSession({ session, sessionId, body });
    if (res.status !== 201) {
      logEngineEphemeralRegisterFailed(engineId, res.status);
      throw new Error(`ephemeral register failed: ${res.status} ${JSON.stringify(res.json)}`);
    }
  };

  const scheduleReconnect = (slot: SessionSlot): void => {
    if (closed || slot.reconnectTimer) return;
    const delay = Math.max(
      reconnectDelayMs(slot.reconnectAttempt),
      poolReconnectCircuitDelayMs(),
    );
    slot.reconnectTimer = setTimeout(() => {
      slot.reconnectTimer = null;
      void reconnectSlot(slot);
    }, delay);
  };

  const reconnectSlot = async (slot: SessionSlot): Promise<void> => {
    if (closed) return;
    const sessionId = slot.sessionId;
    slot.reconnectAttempt += 1;
    const attempt = slot.reconnectAttempt;
    let gracefulDisconnect = false;
    try {
      slot.pullWorker.stop();
      slot.session.removeListener("close", slot.onClose);
      slot.session.removeListener("error", slot.onClose);
      gracefulDisconnect = await gracefulDisconnectAttestedSession(
        slot.session,
        sessionId,
        engineId,
        "admin",
      )
        .then(() => true)
        .catch(() => false);
      if (!slot.session.destroyed) slot.session.close();
      applyFreshAttestation();
      const reconnectChallenge = connectChallengeForBatch();
      const session = await openConnection(
        poolConnectOpts(slot.gatewayBaseUrl, reconnectChallenge),
        sessionId,
      );
      slot.session = session;
      slot.reconnectAttempt = 0;
      bindSessionClose(slot);
      await registerEpochOnSession(session, sessionId);
      slot.pullWorker = startPullWorker(session, sessionId, inference, opts.onError);
      supervisor.markHealthy();
      clearPoolReconnectCircuit();
      logEngineSessionReconnect(engineId, sessionId, attempt, { gracefulDisconnect });
    } catch (e) {
      logEngineSessionReconnect(engineId, sessionId, attempt, { gracefulDisconnect });
      logEnginePoolConnectFailed(
        engineId,
        slot.gatewayBaseUrl,
        e instanceof Error ? e.message : String(e),
      );
      supervisor.markUnhealthy();
      recordPoolReconnectFailure();
      scheduleReconnect(slot);
    }
  };

  const bindSessionClose = (slot: SessionSlot): void => {
    slot.session.removeListener("close", slot.onClose);
    slot.session.removeListener("error", slot.onClose);
    slot.onClose = () => {
      if (closed) return;
      supervisor.markUnhealthy();
      scheduleReconnect(slot);
    };
    slot.session.on("close", slot.onClose);
    slot.session.on("error", slot.onClose);
  };

  const attachSlotCore = async (
    gatewayBaseUrl: string,
    gatewayChallengeNonce?: string,
  ): Promise<SessionSlot> => {
    const sessionId = randomUUID();
    const session = await openConnection(
      poolConnectOpts(gatewayBaseUrl, gatewayChallengeNonce),
      sessionId,
    );
    const slot: SessionSlot = {
      sessionId,
      session,
      gatewayBaseUrl,
      pullWorker: noopPullWorker(),
      reconnectTimer: null,
      reconnectAttempt: 0,
      onClose: () => undefined,
    };
    bindSessionClose(slot);
    return slot;
  };

  const startPullWorkerOnSlot = (slot: SessionSlot): void => {
    slot.pullWorker = startPullWorker(slot.session, slot.sessionId, inference, opts.onError);
  };

  const migrateOneSession = async (slot: SessionSlot, targetUrl: string): Promise<void> => {
    if (slot.pullWorker.isBusy()) {
      throw new Error(`session ${slot.sessionId} busy — cannot migrate`);
    }
    if (slot.gatewayBaseUrl === targetUrl) return;

    const sessionId = randomUUID();
    applyFreshAttestation();
    const migrateChallenge = connectChallengeForBatch();
    const newSession = await openConnection(
      poolConnectOpts(targetUrl, migrateChallenge),
      sessionId,
    );

    slot.pullWorker.stop();
    slot.session.removeListener("close", slot.onClose);
    slot.session.removeListener("error", slot.onClose);
    await gracefulDisconnectAttestedSession(
      slot.session,
      slot.sessionId,
      engineId,
      "upgrade",
    ).catch(() => undefined);
    if (!slot.session.destroyed) slot.session.close();

    slot.sessionId = sessionId;
    slot.session = newSession;
    slot.gatewayBaseUrl = targetUrl;
    slot.reconnectAttempt = 0;
    bindSessionClose(slot);
    await registerEpochOnSession(newSession, sessionId);
    slot.pullWorker = startPullWorker(newSession, sessionId, inference, opts.onError);
  };

  const drainSlotAt = async (index: number): Promise<void> => {
    const slot = slots[index];
    if (!slot) return;
    if (slot.pullWorker.isBusy()) {
      throw new Error(`session ${slot.sessionId} busy — cannot drain`);
    }
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = null;
    }
    slot.pullWorker.stop();
    slot.session.removeListener("close", slot.onClose);
    slot.session.removeListener("error", slot.onClose);
    await gracefulDisconnectAttestedSession(
      slot.session,
      slot.sessionId,
      engineId,
      "upgrade",
    ).catch(() => undefined);
    if (!slot.session.destroyed) slot.session.close();
    slots.splice(index, 1);
  };

  const poolInitialFraction =
    opts.poolInitialFraction ?? poolInitialFractionFromEnv(process.env);
  const bootSessionCount = initialPoolSessionCount(opts.poolTargetSize, poolInitialFraction);
  if (bootSessionCount < 1) {
    throw new Error(
      `supervised pool requires at least one boot session (poolTargetSize=${opts.poolTargetSize}, poolInitialFraction=${poolInitialFraction})`,
    );
  }

  const connectConcurrency = poolConnectConcurrencyFromEnv(process.env, bootSessionCount);
  const bootChallenge = connectChallengeForBatch();
  const bootSlots = await mapWithConcurrency(bootSessionCount, connectConcurrency, () =>
    attachSlotCore(primaryGatewayUrl, bootChallenge),
  );
  slots.push(...bootSlots);

  await rotator.registerInitialEpoch();
  for (const slot of slots) {
    startPullWorkerOnSlot(slot);
  }
  rotator.start();
  supervisor.markHealthy();

  pruneTimer = setInterval(() => {
    decryptor.pruneRetired(Date.now(), policy.overlapGraceMs);
  }, PRUNE_INTERVAL_MS);

  const sessionWatchTimer = setInterval(() => {
    if (closed) return;
    for (const slot of slots) {
      if ((slot.session.closed || slot.session.destroyed) && !slot.reconnectTimer) {
        scheduleReconnect(slot);
      }
    }
  }, 5_000);

  return {
    get sessionIds() {
      return slots.map((s) => s.sessionId);
    },
    get sessions() {
      return slots.map((s) => s.session);
    },
    decryptor,
    rotator,
    currentEpoch: () => rotator.currentEpoch(),
    sessionsByGatewayUrl: () => sessionsByGatewayUrlFromSlots(slots),
    migrateGatewayPool: async (targetUrl: string, fraction: number): Promise<GatewayMigrationResult> => {
      const normalized = targetUrl.trim();
      const onTarget = slots.filter((s) => s.gatewayBaseUrl === normalized).length;
      const sourceSlots = slots.filter((s) => s.gatewayBaseUrl !== normalized);
      const idleOnSource = sourceSlots.filter((s) => !s.pullWorker.isBusy()).length;
      const plan = planGatewayMigration({
        poolSize: slots.length,
        onTarget,
        fraction,
        idleOnSource,
      });

      let moved = 0;
      for (let i = 0; i < plan.toMove; i++) {
        const candidate = slots.find(
          (s) => s.gatewayBaseUrl !== normalized && !s.pullWorker.isBusy(),
        );
        if (!candidate) break;
        await migrateOneSession(candidate, normalized);
        moved += 1;
      }

      const finalOnTarget = slots.filter((s) => s.gatewayBaseUrl === normalized).length;
      return {
        moved,
        onTarget: finalOnTarget,
        onSource: slots.length - finalOnTarget,
        targetCount: plan.targetCount,
        blocked: plan.blocked && moved < plan.toMove,
        reason: plan.reason,
      };
    },
    drainIdlePool: async (fraction: number): Promise<PoolDrainResult> => {
      const idleCount = slots.filter((s) => !s.pullWorker.isBusy()).length;
      const plan = planPoolDrain({
        poolTargetSize: opts.poolTargetSize,
        currentCount: slots.length,
        fraction,
        idleCount,
      });

      let drained = 0;
      for (let i = 0; i < plan.toDrain; i++) {
        const index = slots.findIndex((s) => !s.pullWorker.isBusy());
        if (index < 0) break;
        await drainSlotAt(index);
        drained += 1;
      }

      const remaining = slots.length;
      return {
        drained,
        remaining,
        targetRemaining: plan.targetRemaining,
        blocked: plan.blocked || (plan.toDrain > 0 && drained < plan.toDrain),
        reason: plan.reason,
      };
    },
    scalePool: async (targetSize: number): Promise<PoolScaleResult> => {
      const plan = planPoolScale({
        poolTargetSize: opts.poolTargetSize,
        currentCount: slots.length,
        targetSize,
      });
      if (plan.blocked) {
        return {
          added: 0,
          total: slots.length,
          targetSize,
          blocked: true,
          reason: plan.reason,
        };
      }

      const scaleConcurrency = poolConnectConcurrencyFromEnv(process.env, plan.toAdd);
      const scaleChallenge = connectChallengeForBatch();
      const scaledSlots = await mapWithConcurrency(plan.toAdd, scaleConcurrency, async () => {
        const slot = await attachSlotCore(primaryGatewayUrl, scaleChallenge);
        await registerEpochOnSession(slot.session, slot.sessionId);
        startPullWorkerOnSlot(slot);
        return slot;
      });
      slots.push(...scaledSlots);
      const added = scaledSlots.length;

      if (added > 0) {
        logEnginePoolScale(engineId, added, slots.length);
      }

      return {
        added,
        total: slots.length,
        targetSize: plan.targetSize,
        blocked: false,
      };
    },
    close: async (reason: AttestedDisconnectRequest["reason"] = "shutdown") => {
      closed = true;
      rotator.stop();
      if (pruneTimer) clearInterval(pruneTimer);
      if (sessionWatchTimer) clearInterval(sessionWatchTimer);
      supervisor.markUnhealthy();
      for (const slot of slots) {
        if (slot.reconnectTimer) clearTimeout(slot.reconnectTimer);
        slot.pullWorker.stop();
        slot.session.removeListener("close", slot.onClose);
        slot.session.removeListener("error", slot.onClose);
      }
      const { postDisconnectOnAttestedSession } = await import("../engine-plane/pool-client.js");
      await Promise.all(
        slots.map((slot) =>
          postDisconnectOnAttestedSession({
            session: slot.session,
            sessionId: slot.sessionId,
            engineId,
            reason,
          }).catch(() => undefined),
        ),
      );
      for (const slot of slots) {
        if (!slot.session.destroyed) slot.session.close();
      }
    },
  };
}
