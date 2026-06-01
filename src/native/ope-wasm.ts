/**
 * Load `ope-wasm` (wasm-pack `web` target) for browser / Capacitor WebView.
 */

import type { WasmOpeClientFfi } from "../crypto/wasm-client-provider.js";

export interface OpeWasmModule {
  default: (input?: unknown) => Promise<unknown>;
  ope_wasm_version: () => string;
  ope_wasm_client_encrypt_request: (
    engineIdentityJson: string,
    payloadJson: string,
    baseEnvelopeJson: string,
    wantResponseSession: boolean,
  ) => string;
  ope_wasm_client_decrypt_response_chunk: (
    clientSession: number,
    requestEnvelopeJson: string,
    serverShareB64: string,
    seq: number,
    ciphertextB64: string,
  ) => string;
  ope_wasm_client_session_free: (clientSession: number) => void;
}

let initPromise: Promise<WasmOpeClientFfi | null> | null = null;

function decodePlaintextB64(json: string): Uint8Array {
  const v = JSON.parse(json) as { plaintext_b64?: string };
  const b64 = v.plaintext_b64 ?? "";
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64url"));
  }
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function wrapModule(mod: OpeWasmModule): WasmOpeClientFfi {
  return {
    clientEncryptRequest(engineIdentity, payload, baseEnvelope, wantResponseSession) {
      const raw = mod.ope_wasm_client_encrypt_request(
        JSON.stringify(engineIdentity),
        JSON.stringify(payload),
        JSON.stringify(baseEnvelope),
        wantResponseSession,
      );
      const parsed = JSON.parse(raw) as {
        envelope: Record<string, unknown>;
        client_session: number | null;
      };
      return {
        envelope: parsed.envelope,
        client_session: parsed.client_session,
      };
    },
    clientDecryptResponseChunk(
      clientSession,
      requestEnvelope,
      serverShareB64,
      seq,
      ciphertextB64,
    ) {
      const raw = mod.ope_wasm_client_decrypt_response_chunk(
        clientSession,
        JSON.stringify(requestEnvelope),
        serverShareB64,
        seq,
        ciphertextB64,
      );
      return decodePlaintextB64(raw);
    },
    clientSessionFree(clientSession) {
      mod.ope_wasm_client_session_free(clientSession);
    },
  };
}

/** Initialize WASM and return client FFI, or `null` if the bundle is missing. */
export async function loadOpeWasm(): Promise<WasmOpeClientFfi | null> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      // @ts-expect-error optional WASM bundle (see `pnpm build:ope-wasm`)
      const mod = (await import("../../pkg/ope-wasm/ope_wasm.js")) as OpeWasmModule;
      await mod.default();
      return wrapModule(mod);
    } catch {
      return null;
    }
  })();
  return initPromise;
}

export function __resetOpeWasmCacheForTests(): void {
  initPromise = null;
}
