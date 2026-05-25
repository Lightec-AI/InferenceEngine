# @teechat/inference-engine

TeaChat **inference engine** package: decrypt OPE envelopes, plan vLLM KV prefill, call vLLM, encrypt responses, and sign usage reports.

The TeeChat gateway (`server/confidential-ai/` in the main repo) handles registry, affinity, and opaque forward only.

## Layout

| Path | Role |
|------|------|
| `src/protocol/types.ts` | Gateway ↔ engine HTTP contract types |
| `src/prefill.ts` | KV prefill planner |
| `src/attestation.ts` | Attestation verify (mock; production → OPE `ope-attest`) |
| `src/ephemeral.ts` | Ephemeral epoch signatures |
| `src/metering.ts` | Usage report canonical bytes + Ed25519 |
| `src/client-trust.ts` | Client trust bundle verification |
| `src/server/mock-inference.ts` | Dev/test `POST /v1/ope/inference` stub |
| `src/testing/` | Mock engine keys and quotes for integration tests |
| `docs/` | Engine design notes |

## Scripts

```bash
pnpm install
pnpm test
pnpm typecheck
```

## Docs

- [docs/kv-cache-prefill.md](./docs/kv-cache-prefill.md)
- [docs/inference-engine-keys-and-attestation.md](./docs/inference-engine-keys-and-attestation.md)

TeeChat gateway/runtime docs remain in the parent repo under `docs/design/`.
