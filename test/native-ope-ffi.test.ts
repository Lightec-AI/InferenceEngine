import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  __resetOpeFfiCacheForTests,
  candidateLibraryPaths,
  loadOpeFfi,
  OpeFfiError,
  requireOpeFfi,
} from "../src/native/ope-ffi.js";

function rawEd25519PublicB64Url(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(-32).toString("base64url");
}

describe("ope-ffi native binding", () => {
  it("lists candidate library paths with env override first", () => {
    const paths = candidateLibraryPaths({ TEECHAT_OPE_FFI_LIB: "/tmp/custom.dylib" });
    expect(paths[0]).toBe("/tmp/custom.dylib");
    expect(paths.length).toBeGreaterThan(1);
  });

  it("performs a real hybrid request/response roundtrip through the C ABI", () => {
    __resetOpeFfiCacheForTests();
    const ffi = loadOpeFfi();
    if (!ffi) {
      throw new Error(
        `ope-ffi library not built; expected one of: ${candidateLibraryPaths().join(", ")}`,
      );
    }

    const edB64 = rawEd25519PublicB64Url();
    const { handle, identity } = ffi.engineGenerate("engine-native", edB64);
    expect(identity.kex).toBe("X25519MLKEM768");
    expect(identity.mlkem_encapsulation_key.length).toBeGreaterThan(1000);
    expect(identity.ed25519_public).toBe(edB64);

    const payload = {
      model: "llama3@teechat",
      messages: [{ role: "user", content: "secret prompt" }],
    };
    const baseEnvelope = {
      ope_version: "1.0",
      alg: "EdDSA",
      enc: "none",
      kid: "user-1",
      recipient: "teechat-gateway",
      ts: new Date().toISOString(),
      nonce: "nonce-native-1",
      payload_hash: "",
    };

    const { envelope, client_session } = ffi.clientEncryptRequest(
      identity,
      payload,
      baseEnvelope,
      true,
    );
    expect(envelope.enc).toBe("e2e-hybrid-pq");
    expect(typeof envelope.ciphertext).toBe("string");
    expect(client_session).not.toBeNull();

    const decrypted = ffi.engineDecryptRequest(handle, envelope);
    expect(decrypted).toEqual(payload);

    const { session, server_share } = ffi.engineBeginResponse(handle, envelope);
    expect(server_share.length).toBeGreaterThan(1000);

    const chunkPlain = Buffer.from("assistant streamed answer", "utf8");
    const ciphertext = ffi.responseEncryptChunk(session, 0, chunkPlain);
    const recovered = ffi.clientDecryptResponseChunk(
      client_session!,
      envelope,
      server_share,
      0,
      ciphertext,
    );
    expect(recovered.equals(chunkPlain)).toBe(true);

    ffi.responseFree(session);
    ffi.clientSessionFree(client_session!);
    ffi.engineFree(handle);
  });

  it("rejects an unknown engine handle with OpeFfiError", () => {
    const ffi = requireOpeFfi();
    expect(() =>
      ffi.engineDecryptRequest(9_999_999, {
        ope_version: "1.0",
        alg: "EdDSA",
        enc: "e2e-hybrid-pq",
        kid: "k",
        recipient: "r",
        ts: new Date().toISOString(),
        nonce: "n",
        payload_hash: "",
      }),
    ).toThrow(OpeFfiError);
  });

  it("tampered ciphertext fails authentication on decrypt", () => {
    const ffi = requireOpeFfi();
    const edB64 = rawEd25519PublicB64Url();
    const { handle, identity } = ffi.engineGenerate("engine-tamper", edB64);
    const payload = { model: "llama3@teechat", messages: [] };
    const { envelope } = ffi.clientEncryptRequest(
      identity,
      payload,
      {
        ope_version: "1.0",
        alg: "EdDSA",
        enc: "none",
        kid: "user-1",
        recipient: "teechat-gateway",
        ts: new Date().toISOString(),
        nonce: "nonce-tamper",
        payload_hash: "",
      },
      false,
    );
    const tampered = { ...envelope, ciphertext: `${(envelope.ciphertext as string).slice(0, -2)}AA` };
    expect(() => ffi.engineDecryptRequest(handle, tampered)).toThrow(OpeFfiError);
    ffi.engineFree(handle);
  });
});
