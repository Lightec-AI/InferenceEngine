# @teechat/inference-engine

TeaChat **inference engine** package: decrypt OPE envelopes, plan vLLM KV prefill, call vLLM, encrypt responses, and sign usage reports.

The TeeChat gateway (`server/confidential-ai/` in the main repo) handles registry, affinity, and opaque forward only. The engine performs real hybrid PQ decryption via the OPE FFI (see "Real crypto" below).

## Layout

| Path | Role |
|------|------|
| `src/protocol/types.ts` | Gateway ↔ engine HTTP contract types |
| `src/prefill.ts` | KV prefill planner |
| `src/build-mode.ts` | Dev/prod gate (`mockAllowed` is false in production) |
| `src/native/ope-ffi.ts` | koffi binding over the `ope-ffi` cdylib (real hybrid E2E) |
| `src/crypto/provider.ts` | Crypto provider seam: real (FFI) vs mock; fail-closed in prod |
| `src/engine/epoch.ts` | Real engine epoch keygen + signed ephemeral identity |
| `src/client/ope-client.ts` | Client: trust verify → encrypt request → decrypt response stream |
| `src/attestation.ts` | Attestation verify; mock HMAC (dev) vs production backend seam |
| `src/ephemeral.ts` | Ephemeral epoch signatures |
| `src/metering.ts` | Usage report canonical bytes + Ed25519 |
| `src/client-trust.ts` | Client trust bundle verification |
| `src/server/mock-inference.ts` | Dev/test `POST /v1/ope/inference` stub (optional real decrypt) |
| `src/testing/` | Mock engine keys and quotes for integration tests |
| `docs/` | Engine design notes |

## Real crypto (OPE FFI)

The hybrid PQ E2E path (X25519MLKEM768 + ChaCha20-Poly1305) is implemented in Rust
(`vendor/ope`) and exposed to Node via the `ope-ffi` cdylib loaded with `koffi`.

```bash
pnpm build:ffi   # cargo build -p ope-ffi (release) from the sibling vendor/ope
```

The native library is resolved from `TEECHAT_OPE_FFI_LIB`, the sibling `../ope/target`,
or `vendor/ope/target`. Build mode is controlled by `TEECHAT_BUILD`/`NODE_ENV`:

- **production** — real provider/attestation required; mocks refused (fail closed).
- **development** — real when the library is available, else mock; override with
  `TEECHAT_CRYPTO=real|mock` and force real attestation with `TEECHAT_FORCE_REAL_CRYPTO=1`.

> Note: `koffi` is a Node-native loader. Browser/mobile (Capacitor) clients need a WASM
> build of `ope-ffi` (future work); the binding here serves the engine and Node clients.

## Scripts

```bash
pnpm install
pnpm build:ffi   # build the native hybrid-crypto library
pnpm test
pnpm typecheck
```

## Docs

- [docs/kv-cache-prefill.md](./docs/kv-cache-prefill.md)
- [docs/inference-engine-keys-and-attestation.md](./docs/inference-engine-keys-and-attestation.md)

TeeChat gateway/runtime docs remain in the parent repo under `docs/design/`.
