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

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PRUNE_INTERVAL_MS = 60_000;

export interface SupervisedEnginePlanePoolOptions extends EnginePlanePoolClientOptions {
  ed25519PublicB64: string;
  ed25519PrivateKey: KeyObject;
  attestation?: AttestationBundle;
  provider: CryptoProvider;
  /** When false, behaves like legacy pool (no rotation/reconnect). Default true. */
  supervised?: boolean;
}

export interface SupervisedEnginePlanePool {
  sessionIds: string[];
  sessions: ClientHttp2Session[];
  decryptor: RotatingEpochDecryptor;
  rotator: EpochRotator;
  currentEpoch(): EngineEpoch;
  close(reason?: AttestedDisconnectRequest["reason"]): Promise<void>;
}

interface SessionSlot {
  sessionId: string;
  session: ClientHttp2Session;
  stopWorker: () => void;
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
  const policy = epochRotationPolicyFromEnv();
  const slots: SessionSlot[] = [];
  let closed = false;
  let pruneTimer: ReturnType<typeof setInterval> | null = null;

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
    const delay = reconnectDelayMs(slot.reconnectAttempt);
    slot.reconnectTimer = setTimeout(() => {
      slot.reconnectTimer = null;
      void reconnectSlot(slot);
    }, delay);
  };

  const reconnectSlot = async (slot: SessionSlot): Promise<void> => {
    if (closed) return;
    slot.reconnectAttempt += 1;
    logEngineSessionReconnect(engineId, slot.sessionId, slot.reconnectAttempt);
    try {
      slot.stopWorker();
      if (!slot.session.destroyed) slot.session.close();
      const sessionId = randomUUID();
      const session = await openPooledConnection(opts, sessionId);
      slot.sessionId = sessionId;
      slot.session = session;
      slot.reconnectAttempt = 0;
      bindSessionClose(slot);
      await registerEpochOnSession(session, sessionId);
      slot.stopWorker = startPullWorker(session, sessionId, inference, opts.onError);
      supervisor.markHealthy();
    } catch (e) {
      logEnginePoolConnectFailed(
        engineId,
        opts.gatewayBaseUrl,
        e instanceof Error ? e.message : String(e),
      );
      supervisor.markUnhealthy();
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

  for (let i = 0; i < opts.poolTargetSize; i++) {
    const sessionId = randomUUID();
    const session = await openPooledConnection(opts, sessionId);
    const slot: SessionSlot = {
      sessionId,
      session,
      stopWorker: startPullWorker(session, sessionId, inference, opts.onError),
      reconnectTimer: null,
      reconnectAttempt: 0,
      onClose: () => undefined,
    };
    bindSessionClose(slot);
    slots.push(slot);
  }

  await rotator.registerInitialEpoch();
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
    close: async (reason: AttestedDisconnectRequest["reason"] = "shutdown") => {
      closed = true;
      rotator.stop();
      if (pruneTimer) clearInterval(pruneTimer);
      if (sessionWatchTimer) clearInterval(sessionWatchTimer);
      supervisor.markUnhealthy();
      for (const slot of slots) {
        if (slot.reconnectTimer) clearTimeout(slot.reconnectTimer);
        slot.stopWorker();
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
