/**
 * Confidential AI client: fetch an engine trust bundle, verify it (attestation +
 * epoch + identity signature), then encrypt the request and decrypt the response
 * stream — all real hybrid PQ crypto via the OPE FFI provider.
 *
 * This is the reference client used by tests and by the TeaChat app/runtime. It is
 * transport-light: it takes a `fetch`-compatible function so it can run in Node, the
 * browser, or Capacitor.
 */

import { randomUUID } from "node:crypto";

import type { AttestationPolicy } from "../attestation.js";
import { verifyEngineTrustBundle } from "../client-trust.js";
import { resolveCryptoProvider, type CryptoProvider } from "../crypto/provider.js";
import type {
  EngineTrustBundle,
  OpeEnvelope,
  OpeEnvelopeMeta,
} from "../protocol/types.js";

export interface VerifiedEngine {
  engineId: string;
  epochId: string;
  identity: {
    engine_id: string;
    kex: string;
    mlkem_encapsulation_key: string;
    x25519_public: string;
    ed25519_public: string;
  };
  trust: EngineTrustBundle;
}

/** Live client request session: holds the ephemeral handle for response decryption. */
export interface ClientRequestSession {
  clientSession: number;
  requestEnvelope: OpeEnvelope;
  provider: CryptoProvider;
}

export interface OpeClientOptions {
  gatewayBaseUrl: string;
  tlsClientCertSha256: string;
  attestationPolicy: AttestationPolicy;
  provider?: CryptoProvider;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Optional envelope signer (Ed25519 over canonical bytes); E2E works without it. */
  signEnvelope?: (envelope: OpeEnvelope) => OpeEnvelope;
}

export class OpeClient {
  private readonly provider: CryptoProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpeClientOptions) {
    this.provider = opts.provider ?? resolveCryptoProvider(opts.env);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** GET the trust bundle for an engine and verify it; throws on failure. */
  async fetchAndVerifyTrust(engineId: string, nowMs = Date.now()): Promise<VerifiedEngine> {
    const url = `${this.opts.gatewayBaseUrl}/v1/ope/engines/${encodeURIComponent(engineId)}/trust`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`trust fetch failed: HTTP ${res.status}`);
    const trust = (await res.json()) as EngineTrustBundle;

    const verdict = verifyEngineTrustBundle(
      trust,
      this.opts.attestationPolicy,
      this.opts.tlsClientCertSha256,
      nowMs,
    );
    if (!verdict.ok) throw new Error(`trust verification failed: ${verdict.reason}`);

    return {
      engineId: trust.engine_id,
      epochId: trust.epoch_id,
      identity: {
        engine_id: trust.engine_id,
        kex: trust.hybrid.kex,
        mlkem_encapsulation_key: trust.hybrid.mlkem_encapsulation_key,
        x25519_public: trust.hybrid.x25519_public,
        ed25519_public: trust.identity.ed25519_public,
      },
      trust,
    };
  }

  /**
   * Encrypt a chat payload to a verified engine. Returns the signed/encrypted envelope
   * to POST and a session for decrypting the response stream.
   */
  encryptRequest(
    engine: VerifiedEngine,
    payload: unknown,
    args: { kid: string; meta?: OpeEnvelopeMeta; recipient?: string } = { kid: "guest" },
  ): { envelope: OpeEnvelope; session: ClientRequestSession } {
    const base: OpeEnvelope = {
      ope_version: "1.0",
      alg: "EdDSA",
      enc: "none",
      kid: args.kid,
      recipient: args.recipient ?? "teechat-gateway",
      ts: new Date().toISOString(),
      nonce: randomUUID(),
      payload_hash: "",
      engine_id: engine.engineId,
      ...(args.meta ? { meta: args.meta } : {}),
    };

    const { envelope, client_session } = this.provider.clientEncryptRequest(
      engine.identity,
      payload,
      base,
      true,
    );
    if (client_session == null) {
      throw new Error("expected a client response session but none was returned");
    }
    let finalEnvelope = envelope as unknown as OpeEnvelope;
    if (this.opts.signEnvelope) finalEnvelope = this.opts.signEnvelope(finalEnvelope);

    return {
      envelope: finalEnvelope,
      session: {
        clientSession: client_session,
        requestEnvelope: finalEnvelope,
        provider: this.provider,
      },
    };
  }

  /** Decrypt one response stream chunk. */
  static decryptResponseChunk(
    session: ClientRequestSession,
    serverShareB64: string,
    seq: number,
    ciphertextB64: string,
  ): Buffer {
    return session.provider.clientDecryptResponseChunk(
      session.clientSession,
      session.requestEnvelope,
      serverShareB64,
      seq,
      ciphertextB64,
    );
  }

  /** Release the client session's ephemeral secret. */
  static disposeSession(session: ClientRequestSession): void {
    session.provider.freeClientSession(session.clientSession);
  }
}
