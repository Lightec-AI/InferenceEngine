/**
 * Browser / Capacitor client-only crypto via `ope-wasm` (no engine role).
 */

import type { ClientEncryptResult } from "../native/ope-ffi.js";
import type { CryptoProvider, EngineHybridKeypair, ResponseSession } from "./provider.js";

export interface WasmOpeClientFfi {
  clientEncryptRequest(
    engineIdentity: unknown,
    payload: unknown,
    baseEnvelope: unknown,
    wantResponseSession: boolean,
  ): ClientEncryptResult;
  clientDecryptResponseChunk(
    clientSession: number,
    requestEnvelope: unknown,
    serverShareB64: string,
    seq: number,
    ciphertextB64: string,
  ): Uint8Array;
  clientSessionFree(clientSession: number): void;
}

function wasmOnly(op: string): never {
  throw new Error(`WasmClientCryptoProvider cannot ${op} (client-only WASM build)`);
}

export class WasmClientCryptoProvider implements CryptoProvider {
  readonly mode = "real" as const;

  constructor(private readonly ffi: WasmOpeClientFfi) {}

  generateEngineHybrid(_engineId: string, _ed25519PublicB64: string): EngineHybridKeypair {
    return wasmOnly("run engine role");
  }
  decryptRequest(): unknown {
    return wasmOnly("decrypt requests");
  }
  beginResponse(): ResponseSession {
    return wasmOnly("begin response");
  }
  encryptResponseChunk(): string {
    return wasmOnly("encrypt response chunks");
  }
  freeResponse(): void {}
  freeEngine(): void {}

  clientEncryptRequest(
    engineIdentity: unknown,
    payload: unknown,
    baseEnvelope: unknown,
    wantResponseSession: boolean,
  ): ClientEncryptResult {
    return this.ffi.clientEncryptRequest(
      engineIdentity,
      payload,
      baseEnvelope,
      wantResponseSession,
    );
  }

  clientDecryptResponseChunk(
    clientSession: number,
    requestEnvelope: unknown,
    serverShareB64: string,
    seq: number,
    ciphertextB64: string,
  ): Buffer {
    const bytes = this.ffi.clientDecryptResponseChunk(
      clientSession,
      requestEnvelope,
      serverShareB64,
      seq,
      ciphertextB64,
    );
    return Buffer.from(bytes);
  }

  freeClientSession(clientSession: number): void {
    this.ffi.clientSessionFree(clientSession);
  }
}

export function createWasmClientCryptoProvider(ffi: WasmOpeClientFfi): CryptoProvider {
  return new WasmClientCryptoProvider(ffi);
}
