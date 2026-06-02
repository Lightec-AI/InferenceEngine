/**
 * Browser / Capacitor client-only crypto via `ope-wasm` (no engine role, no Node `provider` / `ope-ffi`).
 */

export interface WasmClientEncryptResult {
  envelope: Record<string, unknown>;
  client_session: number | null;
}

export interface WasmOpeClientFfi {
  clientEncryptRequest(
    engineIdentity: unknown,
    payload: unknown,
    baseEnvelope: unknown,
    wantResponseSession: boolean,
  ): WasmClientEncryptResult;
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

export class WasmClientCryptoProvider {
  readonly mode = "real" as const;

  constructor(private readonly ffi: WasmOpeClientFfi) {}

  clientEncryptRequest(
    engineIdentity: unknown,
    payload: unknown,
    baseEnvelope: unknown,
    wantResponseSession: boolean,
  ): WasmClientEncryptResult {
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
  ): Uint8Array {
    return this.ffi.clientDecryptResponseChunk(
      clientSession,
      requestEnvelope,
      serverShareB64,
      seq,
      ciphertextB64,
    );
  }

  freeClientSession(clientSession: number): void {
    this.ffi.clientSessionFree(clientSession);
  }

  /** Engine / gateway roles are unavailable in the WASM client build. */
  generateEngineHybrid(): never {
    return wasmOnly("run engine role");
  }
}

export function createWasmClientCryptoProvider(ffi: WasmOpeClientFfi): WasmClientCryptoProvider {
  return new WasmClientCryptoProvider(ffi);
}
