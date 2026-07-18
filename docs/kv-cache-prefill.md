# KV cache prefill (inference engine)

How the **TeeChat inference engine** (not the gateway or OPE library) uses **vLLM automatic prefix caching (APC)** and issues **internal prefill** calls to reduce **TTFT**.

OPE (`vendor/ope`) is crypto only. The gateway forwards opaque envelopes; only the engine decrypts and talks to vLLM.

## vLLM: what APC reuses

With `enable_prefix_caching=True`, vLLM stores KV blocks keyed by **input token prefixes** across requests on the same process.

| Reused | Not reused |
|--------|------------|
| System + prior user turns after first request | Completion KV unless assistant text is in the next prompt `messages` |
| Prior assistant turns included in the next prompt | New user message tokens on first appearance |
| Same engine instance ([affinity](./ope-engine-registry.md)) | Prefix after template/model change |

## Engine-owned prefill

On each `POST /v1/ope/inference` the engine:

1. **Decrypt** the OPE envelope (OPE library).
2. **Tokenize** the chat prompt for the requested model.
3. **Plan** warm vs cold tokens (`planVllmPrefill` in `src/prefill.ts`).
4. If `coldSuffixTokens > 0`, call **vLLM prefill only** (e.g. OpenAI-compatible `max_tokens: 0` on the full prompt, or an engine-internal prefill API) so APC holds the prefix through the last committed token.
5. **Generate** the user-visible completion (stream or non-stream).
6. **Update** per-`conversation_id` KV state on the engine; return signed usage (`prompt_tokens` includes prefill + decode prompt work).

The gateway exposes only **`POST /v1/ope/chat/completions`** → forward to **`POST /v1/ope/inference`**. No gateway or client prefill route.

### When to prefill early (engine policy)

| Trigger | Engine action |
|---------|----------------|
| After finishing a completion | Background prefill of full thread through last assistant (optional idle job) |
| On new inference request | Prefill any cold suffix before first decode token |
| APC miss (hash / token mismatch) | Full prompt prefill then generate |

Clients send a single chat envelope per turn; TTFT optimization is entirely inside the engine + vLLM.

## Operations

- Enable vLLM APC on inference deploys.
- Keep gateway **conversation affinity** so APC blocks stay on one engine.
- Include **full committed history** in the decrypted prompt each turn.
- Meter `prompt_tokens` for prefill work; `completion_tokens` only for streamed output.

## Code (this package)

| Piece | Location |
|-------|----------|
| Prefill planner | `src/prefill.ts` |
| Mock inference HTTP | `src/server/mock-inference.ts` |
| Protocol types | `src/protocol/types.ts` |

Gateway forward-only behavior lives in TeeChat `server/confidential-ai/handlers.ts`. Runtime overview: TeeChat `docs/design/confidential-ai-runtime.md`.
