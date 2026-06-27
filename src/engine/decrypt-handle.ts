/**
 * Resolve native epoch handle for OPE decrypt — supports rotating multi-epoch decryptors.
 */

import type { OpeEnvelope } from "../protocol/types.js";
import type { MockInferenceDecryptor } from "../server/mock-inference.js";
import type { RotatingEpochDecryptor } from "./rotating-decryptor.js";

export function isRotatingEpochDecryptor(
  decryptor: MockInferenceDecryptor,
): decryptor is RotatingEpochDecryptor {
  return typeof (decryptor as RotatingEpochDecryptor).resolveHandle === "function";
}

export function resolveDecryptHandle(decryptor: MockInferenceDecryptor, envelope: OpeEnvelope): number {
  if (isRotatingEpochDecryptor(decryptor)) {
    return decryptor.resolveHandle(envelope);
  }
  return decryptor.handle;
}
