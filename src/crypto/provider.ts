/**
 * Crypto provider seam: a single interface over the hybrid E2E operations, with a
 * real implementation (the `ope-ffi` native binding) and a mock implementation
 * (random public key material, no real decryption) for development.
 *
 * Selection is governed by `build-mode.ts`:
 * - **production** → real provider, required (throws if the native library is missing).
 * - **development** → real provider when the library is available, else mock; override
 *   with `TEECHAT_CRYPTO=real|mock`.
 */

import { randomBytes } from "node:crypto";

import { mockAllowed, resolveBuildMode } from "../build-mode.js";
import { bytesToBase64Url } from "../crypto-util.js";
import {
  loadOpeFfi,
  requireOpeFfi,
  type ClientEncryptResult,
  type EngineGenerateResult,
} from "../native/ope-ffi.js";
import { MOCK_MLKEM_ENCAP_B64URL_LEN, type EngineHybridPublic } from "../protocol/types.js";

export interface EngineHybridKeypair {
  /** Publishable hybrid public material (registered with the gateway). */
  hybrid: EngineHybridPublic;
  /** Native engine epoch handle (held for the epoch lifetime); `null` for mock keys. */
  handle: number | null;
}

export interface ResponseSession {
  session: number;
  serverShare: string;
}

export interface CryptoProvider {
  readonly mode: "real" | "mock";

  // --- engine role -------------------------------------------------------
  generateEngineHybrid(engineId: string, ed25519PublicB64: string): EngineHybridKeypair;
  decryptRequest(handle: number, envelope: unknown): unknown;
  beginResponse(handle: number, requestEnvelope: unknown): ResponseSession;
  encryptResponseChunk(session: number, seq: number, plaintext: Buffer): string;
  freeResponse(session: number): void;
  freeEngine(handle: number): void;

  // --- client role -------------------------------------------------------
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
  freeClientSession(clientSession: number): void;
}

class RealOpeProvider implements CryptoProvider {
  readonly mode = "real" as const;
  private readonly ffi = requireOpeFfi();

  generateEngineHybrid(engineId: string, ed25519PublicB64: string): EngineHybridKeypair {
    const { handle, identity }: EngineGenerateResult = this.ffi.engineGenerate(
      engineId,
      ed25519PublicB64,
    );
    return {
      handle,
      hybrid: {
        kex: identity.kex,
        mlkem_encapsulation_key: identity.mlkem_encapsulation_key,
        x25519_public: identity.x25519_public,
      },
    };
  }
  decryptRequest(handle: number, envelope: unknown): unknown {
    return this.ffi.engineDecryptRequest(handle, envelope);
  }
  beginResponse(handle: number, requestEnvelope: unknown): ResponseSession {
    const { session, server_share } = this.ffi.engineBeginResponse(handle, requestEnvelope);
    return { session, serverShare: server_share };
  }
  encryptResponseChunk(session: number, seq: number, plaintext: Buffer): string {
    return this.ffi.responseEncryptChunk(session, seq, plaintext);
  }
  freeResponse(session: number): void {
    this.ffi.responseFree(session);
  }
  freeEngine(handle: number): void {
    this.ffi.engineFree(handle);
  }
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
}

function notReal(op: string): never {
  throw new Error(
    `MockCryptoProvider cannot ${op}: mock keys carry no decryptable secret. ` +
      `Use the real provider (build the ope-ffi library) for genuine E2E.`,
  );
}

/**
 * Development-only provider. Generates correctly-sized but cryptographically random
 * public material so that registry/affinity/metering flows can be exercised without the
 * native library. It cannot decrypt or encrypt real traffic.
 */
class MockCryptoProvider implements CryptoProvider {
  readonly mode = "mock" as const;

  generateEngineHybrid(): EngineHybridKeypair {
    const mlkem = bytesToBase64Url(
      randomBytes(Math.ceil((MOCK_MLKEM_ENCAP_B64URL_LEN * 3) / 4)),
    ).slice(0, MOCK_MLKEM_ENCAP_B64URL_LEN);
    return {
      handle: null,
      hybrid: {
        kex: "X25519MLKEM768",
        mlkem_encapsulation_key: mlkem,
        x25519_public: bytesToBase64Url(randomBytes(32)),
      },
    };
  }
  decryptRequest(): unknown {
    return notReal("decrypt requests");
  }
  beginResponse(): ResponseSession {
    return notReal("begin a response session");
  }
  encryptResponseChunk(): string {
    return notReal("encrypt response chunks");
  }
  freeResponse(): void {}
  freeEngine(): void {}
  clientEncryptRequest(): ClientEncryptResult {
    return notReal("encrypt client requests");
  }
  clientDecryptResponseChunk(): Buffer {
    return notReal("decrypt response chunks");
  }
  freeClientSession(): void {}
}

let cachedProvider: CryptoProvider | undefined;

/** Explicit constructors (used by tests and code that wants a specific implementation). */
export function createRealProvider(): CryptoProvider {
  return new RealOpeProvider();
}
export function createMockProvider(): CryptoProvider {
  return new MockCryptoProvider();
}

/**
 * Resolve the provider for the current build mode. Cached after first call; pass
 * `{ fresh: true }` to bypass the cache (tests).
 */
export function resolveCryptoProvider(
  env: NodeJS.ProcessEnv = process.env,
  opts: { fresh?: boolean } = {},
): CryptoProvider {
  if (!opts.fresh && cachedProvider) return cachedProvider;

  const override = (env.TEECHAT_CRYPTO ?? "").trim().toLowerCase();
  let provider: CryptoProvider;

  if (override === "real") {
    provider = createRealProvider();
  } else if (override === "mock") {
    if (!mockAllowed(env)) {
      throw new Error(
        `TEECHAT_CRYPTO=mock is not permitted in ${resolveBuildMode(env)} builds.`,
      );
    }
    provider = createMockProvider();
  } else if (!mockAllowed(env)) {
    // Production (or forced-real): real is mandatory, fail closed.
    provider = createRealProvider();
  } else {
    // Development default: prefer real when available, else mock.
    provider = loadOpeFfi(env) ? createRealProvider() : createMockProvider();
  }

  if (!opts.fresh) cachedProvider = provider;
  return provider;
}

/** Test-only: clear the cached provider. */
export function __resetCryptoProviderForTests(): void {
  cachedProvider = undefined;
}
