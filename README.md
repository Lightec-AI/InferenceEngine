# @teechat/inference-engine

TeeChat **inference engine** package: decrypt OPE envelopes, plan vLLM KV prefill, call vLLM, encrypt responses, and sign usage reports.

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

## Real crypto (OPE FFI) + runtime release

Hybrid PQ E2E lives in the **OPE** crate. Attested mTLS helpers live in
**teechat-attested-mtls**. InferenceEngine releases a **compiled JS runtime bundle**
plus optional companion `.so` files (same bytes as those upstream Releases).

```bash
pnpm build                 # → dist/inference-engine.mjs
TEECHAT_IE_INCLUDE_NATIVES=1 pnpm pack:runtime   # → dist/release/*.tar.gz + SUMS
pnpm fetch:ffi             # OPE .so only
pnpm fetch:attested-mtls   # attested-mtls .so only
```

Primary measured artifact: `inference-engine-runtime-*.tar.gz` (`engine.binary_sha256`).
OPE / attested-mtls digests are independent attestation fields.

npm dependencies (dev/source layout):

- `@teechat/ope-wasm`
- `@teechat/attested-mtls-node` (set `ATTESTED_MTLS_LIB_PATH` or use `native/`)

Build mode is controlled by `TEECHAT_BUILD`/`NODE_ENV`:

- **production** — real provider/attestation required; mocks refused (fail closed).
- **development** — real when the library is available, else mock; override with
  `TEECHAT_CRYPTO=real|mock` and force real attestation with `TEECHAT_FORCE_REAL_CRYPTO=1`.

> **Node / engine:** `koffi` loads `ope-ffi` (`pnpm build:ffi`).  
> **Browser / Capacitor:** use the `ope-wasm` crate (`pnpm build:wasm` or TeeChat `pnpm build:ope-wasm`).
> TeeChat imports `@teechat/inference-engine/browser` and `@teechat/ope-wasm` — do not import the main
> package barrel from Vite (it pulls Node-only modules).

## Scripts

```bash
pnpm install
pnpm build:ffi   # native ope-ffi cdylib (engine + Node)
pnpm build:wasm  # wasm-pack web bundle → pkg/ope-wasm/
pnpm test
pnpm typecheck
```

## Docs

- [docs/kv-cache-prefill.md](./docs/kv-cache-prefill.md)
- [docs/inference-engine-keys-and-attestation.md](./docs/inference-engine-keys-and-attestation.md)

TeeChat gateway/runtime docs remain in the parent repo under `docs/design/`.
