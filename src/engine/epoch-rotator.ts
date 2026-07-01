/**
 * Ephemeral epoch rotation loop (T-4): register new epochs on attested sessions
 * before not_after, with overlap for in-flight streams.
 */

import type { KeyObject } from "node:crypto";
import type { ClientHttp2Session } from "node:http2";

import type { AttestationBundle } from "../protocol/types.js";
import type { CryptoProvider } from "../crypto/provider.js";
import { postEphemeralOnAttestedSession } from "../engine-plane/pool-client.js";
import {
  logEngineEpochRotateFailed,
  logEngineEpochRotateSuccess,
} from "../ops/engine-events.js";
import { createEngineEpoch, disposeEngineEpoch, type EngineEpoch } from "./epoch.js";
import {
  computeEpochRotateAtMs,
  epochRotationLeadMsFromEnv,
  epochTtlMsFromPolicy,
  type EpochRotationPolicy,
} from "./epoch-rotation-policy.js";
import { epochRotationPolicyFromEnv } from "./supervisor.js";

export interface EpochRotatorSession {
  session: ClientHttp2Session;
  sessionId: string;
}

export interface EpochRotatorOptions {
  engineId: string;
  ed25519PublicB64: string;
  ed25519PrivateKey: KeyObject;
  attestation?: AttestationBundle;
  provider: CryptoProvider;
  policy?: EpochRotationPolicy;
  rotationLeadMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Live attested pool sessions — ephemeral is posted on each after rotation. */
  listSessions: () => EpochRotatorSession[];
  onEpochRotated?: (epoch: EngineEpoch, previous: EngineEpoch | null) => void;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface EpochRotator {
  currentEpoch(): EngineEpoch;
  /** Register initial epoch on all sessions (boot). */
  registerInitialEpoch(): Promise<void>;
  start(): void;
  stop(): void;
  /** Force immediate rotation (tests / recovery). */
  rotateNow(): Promise<void>;
  /** Keep ephemeral register payloads aligned with refreshed connect attestation. */
  setAttestation(bundle: AttestationBundle): void;
}

export function createEpochRotator(opts: EpochRotatorOptions): EpochRotator {
  const policy = opts.policy ?? epochRotationPolicyFromEnv(opts.env);
  const leadMs = opts.rotationLeadMs ?? epochRotationLeadMsFromEnv(opts.env);
  const ttlMs = epochTtlMsFromPolicy(policy);
  const nowFn = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimeoutFn ?? setTimeout;
  const clearTimer = opts.clearTimeoutFn ?? clearTimeout;

  let attestation = opts.attestation;
  let current: EngineEpoch = createEngineEpoch({
    engineId: opts.engineId,
    ed25519PublicB64: opts.ed25519PublicB64,
    ed25519PrivateKey: opts.ed25519PrivateKey,
    attestation,
    ttlMs,
    provider: opts.provider,
  });
  let rotateTimer: ReturnType<typeof setTimeout> | null = null;
  let rotating = false;
  let stopped = false;

  const scheduleNextRotation = (): void => {
    if (stopped) return;
    if (rotateTimer) clearTimer(rotateTimer);
    const at = computeEpochRotateAtMs(current.notAfter, leadMs, nowFn());
    const delay = Math.max(0, at - nowFn());
    rotateTimer = setTimer(() => {
      void rotateInternal();
    }, delay);
  };

  const postEpochToSessions = async (epoch: EngineEpoch): Promise<void> => {
    const sessions = opts.listSessions().filter(
      (s) => !s.session.closed && !s.session.destroyed,
    );
    if (!sessions.length) {
      throw new Error("no live attested sessions for ephemeral register");
    }
    const results = await Promise.all(
      sessions.map(async ({ session, sessionId }) => {
        const res = await postEphemeralOnAttestedSession({
          session,
          sessionId,
          body: epoch.ephemeralRequest,
        });
        return { sessionId, res };
      }),
    );
    let lastError: Error | undefined;
    for (const { sessionId, res } of results) {
      if (res.status !== 201) {
        lastError = new Error(`ephemeral register HTTP ${res.status}: ${JSON.stringify(res.json)}`);
        logEngineEpochRotateFailed(opts.engineId, res.status, sessionId);
      }
    }
    if (lastError) throw lastError;
  };

  const rotateInternal = async (): Promise<void> => {
    if (stopped || rotating) return;
    rotating = true;
    const previous = current;
    try {
      const next = createEngineEpoch({
        engineId: opts.engineId,
        ed25519PublicB64: opts.ed25519PublicB64,
        ed25519PrivateKey: opts.ed25519PrivateKey,
        attestation,
        ttlMs,
        provider: opts.provider,
      });
      await postEpochToSessions(next);
      current = next;
      opts.onEpochRotated?.(next, previous);
      logEngineEpochRotateSuccess(opts.engineId, next.epochId, next.notAfter);
      scheduleNextRotation();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logEngineEpochRotateFailed(opts.engineId, 0, msg);
      if (!stopped) {
        rotateTimer = setTimer(() => {
          void rotateInternal();
        }, 30_000);
      }
    } finally {
      rotating = false;
    }
  };

  return {
    currentEpoch: () => current,
    registerInitialEpoch: async () => {
      await postEpochToSessions(current);
    },
    start() {
      stopped = false;
      scheduleNextRotation();
    },
    stop() {
      stopped = true;
      if (rotateTimer) {
        clearTimer(rotateTimer);
        rotateTimer = null;
      }
    },
    rotateNow: rotateInternal,
    setAttestation(bundle: AttestationBundle) {
      attestation = bundle;
    },
  };
}

/** Dispose all epochs held by rotator state (shutdown). */
export function disposeEpochRotatorEpochs(
  current: EngineEpoch,
  retired: EngineEpoch[] = [],
): void {
  disposeEngineEpoch(current);
  for (const e of retired) disposeEngineEpoch(e);
}
