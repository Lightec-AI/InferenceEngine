/**
 * Multi-epoch decryptor for T-4 rotation overlap — decrypt in-flight requests
 * encrypted to a superseded epoch while new sessions use the current handle.
 */

import type { CryptoProvider } from "../crypto/provider.js";
import type { OpeEnvelope } from "../protocol/types.js";
import type { MockInferenceDecryptor } from "../server/mock-inference.js";
import type { EngineEpoch } from "./epoch.js";
import { disposeEngineEpoch } from "./epoch.js";

export interface RotatingEpochDecryptor extends MockInferenceDecryptor {
  /** Resolve native handle from envelope e2e epoch (falls back to current). */
  resolveHandle(envelope: OpeEnvelope): number;
  /** Register a new epoch; becomes current for new decrypts. */
  addEpoch(epoch: EngineEpoch): void;
  /** Drop retired epochs whose not_after + grace has passed. */
  pruneRetired(nowMs?: number, overlapGraceMs?: number): void;
  currentEpochId(): string | null;
}

export function createRotatingEpochDecryptor(
  initial: EngineEpoch,
  overlapGraceMs = 15 * 60 * 1000,
): RotatingEpochDecryptor {
  const epochs = new Map<string, EngineEpoch>();
  let currentEpochId: string | null = null;

  const addEpoch = (epoch: EngineEpoch): void => {
    epochs.set(epoch.epochId, epoch);
    currentEpochId = epoch.epochId;
  };

  addEpoch(initial);

  const resolveHandle = (envelope: OpeEnvelope): number => {
    const e2e = envelope.e2e;
    const epochId =
      e2e && typeof e2e === "object" && typeof (e2e as { ephemeral_epoch?: string }).ephemeral_epoch === "string"
        ? (e2e as { ephemeral_epoch: string }).ephemeral_epoch
        : currentEpochId;
    const epoch = epochId ? epochs.get(epochId) : undefined;
    const target = epoch ?? (currentEpochId ? epochs.get(currentEpochId) : undefined);
    if (!target || target.handle == null) {
      throw new Error(`no decrypt handle for epoch ${epochId ?? "current"}`);
    }
    return target.handle;
  };

  return {
    get provider(): CryptoProvider {
      return initial.provider;
    },
    get handle(): number {
      const current = currentEpochId ? epochs.get(currentEpochId) : undefined;
      if (current?.handle == null) {
        throw new Error("current epoch has no native decrypt handle");
      }
      return current.handle;
    },
    resolveHandle,
    addEpoch,
    currentEpochId: () => currentEpochId,
    pruneRetired(nowMs = Date.now(), grace = overlapGraceMs) {
      for (const [id, epoch] of epochs) {
        if (id === currentEpochId) continue;
        const end = Date.parse(epoch.notAfter);
        if (!Number.isNaN(end) && nowMs > end + grace) {
          disposeEngineEpoch(epoch);
          epochs.delete(id);
        }
      }
    },
  };
}
