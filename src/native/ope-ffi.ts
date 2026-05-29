/**
 * Thin Node binding over the `ope-ffi` C ABI (built as a cdylib from `vendor/ope`).
 *
 * Real X25519MLKEM768 + ChaCha20-Poly1305 hybrid E2E. Engine epoch secrets, client
 * sessions, and response sessions live in the Rust process behind opaque `u64` handles;
 * this layer only marshals JSON and bytes (base64url) across the boundary.
 *
 * Loading is best-effort: {@link loadOpeFfi} returns `null` when the library is not
 * present, so development builds can fall back to mocks. Production callers must treat
 * a `null` result as fatal (see `build-mode.ts`).
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..");

export interface EngineIdentityFull {
  engine_id: string;
  kex: string;
  mlkem_encapsulation_key: string;
  x25519_public: string;
  ed25519_public: string;
}

export interface EngineGenerateResult {
  handle: number;
  identity: EngineIdentityFull;
}

export interface BeginResponseResult {
  session: number;
  server_share: string;
}

export interface ClientEncryptResult {
  envelope: Record<string, unknown>;
  client_session: number | null;
}

/** Typed surface over the native hybrid E2E functions. */
export interface OpeFfi {
  readonly libraryPath: string;
  engineGenerate(engineId: string, ed25519PublicB64: string): EngineGenerateResult;
  engineFree(handle: number): void;
  engineDecryptRequest(handle: number, envelope: unknown): unknown;
  engineBeginResponse(handle: number, requestEnvelope: unknown): BeginResponseResult;
  responseEncryptChunk(session: number, seq: number, plaintext: Buffer): string;
  responseFree(session: number): void;
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
  ): Buffer;
  clientSessionFree(clientSession: number): void;
}

export class OpeFfiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpeFfiError";
  }
}

function libFileName(): string {
  switch (process.platform) {
    case "darwin":
      return "libope_ffi.dylib";
    case "win32":
      return "ope_ffi.dll";
    default:
      return "libope_ffi.so";
  }
}

/** Candidate locations for the compiled library, in priority order. */
export function candidateLibraryPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const name = libFileName();
  const candidates: string[] = [];
  if (env.TEECHAT_OPE_FFI_LIB) candidates.push(resolve(env.TEECHAT_OPE_FFI_LIB));
  const opeDir = env.TEECHAT_OPE_DIR
    ? resolve(env.TEECHAT_OPE_DIR)
    : resolve(packageRoot, "..", "ope");
  candidates.push(resolve(opeDir, "target", "release", name));
  candidates.push(resolve(opeDir, "target", "debug", name));
  candidates.push(resolve(process.cwd(), "vendor", "ope", "target", "release", name));
  candidates.push(resolve(process.cwd(), "vendor", "ope", "target", "debug", name));
  return candidates;
}

function resolveLibraryPath(env: NodeJS.ProcessEnv): string | null {
  for (const p of candidateLibraryPaths(env)) {
    if (existsSync(p)) return p;
  }
  return null;
}

interface NativeBindings {
  ope_string_free: (ptr: unknown) => void;
  ope_last_error_alloc: () => string | null;
  ope_e2e_engine_generate: (engineId: string, edB64: string) => string | null;
  ope_e2e_engine_free: (handle: number) => number;
  ope_e2e_engine_decrypt_request: (handle: number, envelopeJson: string) => string | null;
  ope_e2e_engine_begin_response: (handle: number, requestJson: string) => string | null;
  ope_e2e_response_encrypt_chunk: (
    session: number,
    seq: number,
    plaintextB64: string,
  ) => string | null;
  ope_e2e_response_free: (session: number) => number;
  ope_e2e_client_encrypt_request: (
    identityJson: string,
    payloadJson: string,
    baseEnvelopeJson: string,
    wantResponseSession: number,
  ) => string | null;
  ope_e2e_client_decrypt_response_chunk: (
    clientSession: number,
    requestJson: string,
    serverShareB64: string,
    seq: number,
    ciphertextB64: string,
  ) => string | null;
  ope_e2e_client_session_free: (clientSession: number) => number;
}

let cached: OpeFfi | null | undefined;

/**
 * Load the native library. Returns a cached instance, or `null` if the library or the
 * `koffi` runtime is unavailable. Throws only on a genuinely corrupt/incompatible library.
 */
export function loadOpeFfi(env: NodeJS.ProcessEnv = process.env): OpeFfi | null {
  if (cached !== undefined) return cached;
  const libPath = resolveLibraryPath(env);
  if (!libPath) {
    cached = null;
    return null;
  }

  let koffi: typeof import("koffi");
  try {
    koffi = require("koffi") as typeof import("koffi");
  } catch {
    cached = null;
    return null;
  }

  const lib = koffi.load(libPath);
  // Disposable string return: koffi auto-frees the heap pointer via ope_string_free
  // after decoding to a JS string, so callers never leak.
  const opeStringFree = lib.func("void ope_string_free(void *s)");
  const HeapJson = koffi.disposable("OpeHeapJson", "str", opeStringFree);

  const native: NativeBindings = {
    ope_string_free: opeStringFree as unknown as NativeBindings["ope_string_free"],
    ope_last_error_alloc: lib.func("ope_last_error_alloc", HeapJson, []),
    ope_e2e_engine_generate: lib.func("ope_e2e_engine_generate", HeapJson, ["str", "str"]),
    ope_e2e_engine_free: lib.func("int ope_e2e_engine_free(uint64_t handle)"),
    ope_e2e_engine_decrypt_request: lib.func("ope_e2e_engine_decrypt_request", HeapJson, [
      "uint64_t",
      "str",
    ]),
    ope_e2e_engine_begin_response: lib.func("ope_e2e_engine_begin_response", HeapJson, [
      "uint64_t",
      "str",
    ]),
    ope_e2e_response_encrypt_chunk: lib.func("ope_e2e_response_encrypt_chunk", HeapJson, [
      "uint64_t",
      "uint32_t",
      "str",
    ]),
    ope_e2e_response_free: lib.func("int ope_e2e_response_free(uint64_t session)"),
    ope_e2e_client_encrypt_request: lib.func("ope_e2e_client_encrypt_request", HeapJson, [
      "str",
      "str",
      "str",
      "int",
    ]),
    ope_e2e_client_decrypt_response_chunk: lib.func(
      "ope_e2e_client_decrypt_response_chunk",
      HeapJson,
      ["uint64_t", "str", "str", "uint32_t", "str"],
    ),
    ope_e2e_client_session_free: lib.func(
      "int ope_e2e_client_session_free(uint64_t client_session)",
    ),
  };

  function lastError(): string {
    try {
      return native.ope_last_error_alloc() ?? "unknown ope-ffi error";
    } catch {
      return "unknown ope-ffi error";
    }
  }

  function parse<T>(result: string | null, op: string): T {
    if (result == null) throw new OpeFfiError(`${op}: ${lastError()}`);
    try {
      return JSON.parse(result) as T;
    } catch (e) {
      throw new OpeFfiError(`${op}: invalid JSON from native layer: ${String(e)}`);
    }
  }

  const api: OpeFfi = {
    libraryPath: libPath,
    engineGenerate(engineId, edB64) {
      return parse<EngineGenerateResult>(
        native.ope_e2e_engine_generate(engineId, edB64),
        "engineGenerate",
      );
    },
    engineFree(handle) {
      native.ope_e2e_engine_free(handle);
    },
    engineDecryptRequest(handle, envelope) {
      return parse<unknown>(
        native.ope_e2e_engine_decrypt_request(handle, JSON.stringify(envelope)),
        "engineDecryptRequest",
      );
    },
    engineBeginResponse(handle, requestEnvelope) {
      return parse<BeginResponseResult>(
        native.ope_e2e_engine_begin_response(handle, JSON.stringify(requestEnvelope)),
        "engineBeginResponse",
      );
    },
    responseEncryptChunk(session, seq, plaintext) {
      const out = parse<{ ciphertext: string }>(
        native.ope_e2e_response_encrypt_chunk(session, seq, plaintext.toString("base64url")),
        "responseEncryptChunk",
      );
      return out.ciphertext;
    },
    responseFree(session) {
      native.ope_e2e_response_free(session);
    },
    clientEncryptRequest(engineIdentity, payload, baseEnvelope, wantResponseSession) {
      return parse<ClientEncryptResult>(
        native.ope_e2e_client_encrypt_request(
          JSON.stringify(engineIdentity),
          JSON.stringify(payload),
          JSON.stringify(baseEnvelope),
          wantResponseSession ? 1 : 0,
        ),
        "clientEncryptRequest",
      );
    },
    clientDecryptResponseChunk(clientSession, requestEnvelope, serverShareB64, seq, ciphertextB64) {
      const out = parse<{ plaintext_b64: string }>(
        native.ope_e2e_client_decrypt_response_chunk(
          clientSession,
          JSON.stringify(requestEnvelope),
          serverShareB64,
          seq,
          ciphertextB64,
        ),
        "clientDecryptResponseChunk",
      );
      return Buffer.from(out.plaintext_b64, "base64url");
    },
    clientSessionFree(clientSession) {
      native.ope_e2e_client_session_free(clientSession);
    },
  };

  cached = api;
  return api;
}

/** Like {@link loadOpeFfi} but throws when the library is unavailable. */
export function requireOpeFfi(env: NodeJS.ProcessEnv = process.env): OpeFfi {
  const ffi = loadOpeFfi(env);
  if (!ffi) {
    throw new OpeFfiError(
      `ope-ffi native library not found. Searched: ${candidateLibraryPaths(env).join(", ")}. ` +
        `Build it with \`pnpm build:ffi\` (or set TEECHAT_OPE_FFI_LIB).`,
    );
  }
  return ffi;
}

/** Test-only: reset the module-level cache. */
export function __resetOpeFfiCacheForTests(): void {
  cached = undefined;
}
