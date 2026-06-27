import { createHash } from "node:crypto";

import { conversationKvKey, planVllmPrefill } from "../prefill.js";
import type { OpeEnvelope, SignedUsageReport } from "../protocol/types.js";
import { resolveDecryptHandle } from "../engine/decrypt-handle.js";
import { CONTENT_TYPE_OPE_JSON } from "../protocol/types.js";
import { vllmConfigFromEnv, type TaskVllmRouting } from "../upstream/vllm-chat.js";
import type { MockInferenceDecryptor } from "../server/mock-inference.js";
import { opeInferenceRejectBody, validateOpeInferenceEnvelope } from "../server/ope-inference-gate.js";
import {
  isGatewayPlaneTaskEnvelope,
  runGatewayPlaneTaskInference,
} from "../server/gateway-plane-task-inference.js";
import {
  runOpeInferenceOnEnvelope,
  type OpeInferenceOptions,
  type OpeNdjsonStreamWriter,
} from "../server/ope-inference.js";

export interface MockInferenceOptions {
  requestId?: string;
  decryptor?: MockInferenceDecryptor;
  onInference?: (
    envelope: OpeEnvelope,
    prefillTokens: number,
    completionTokens?: number,
  ) => SignedUsageReport;
  responseBody?: (envelope: OpeEnvelope, prefillTokens: number) => string;
  delayMs?: number;
  /** When set (or `VLLM_BASE_URL` env), use real vLLM upstream instead of mock JSON body. */
  vllm?: OpeInferenceOptions["vllm"];
  /** Task vLLM upstream for background model ids (localhost :8001 in prod-engine). */
  taskVllm?: TaskVllmRouting;
  /** When false, ignore `VLLM_BASE_URL` / `TEECHAT_VLLM_BASE_URL` (used by gateway unit tests). */
  useEnvVllm?: boolean;
  /** Emit OPE §7 NDJSON frames on the engine→gateway inference result stream. */
  ndjsonStream?: OpeNdjsonStreamWriter;
}

interface DecryptedChatPayload {
  messages?: Array<{ role?: string; content?: unknown }>;
}

function tokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function promptTokensFromPayload(payload: DecryptedChatPayload): number {
  const text = (payload.messages ?? [])
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join(" ");
  return tokensFromText(text);
}

function prefixHash(envelope: OpeEnvelope): string {
  return createHash("sha256")
    .update(envelope.meta?.conversation_id ?? "")
    .digest("hex");
}

const kvByConversation = new Map<string, { prefixHash: string; prefilledTokens: number }>();

export async function runMockInferenceOnEnvelope(
  envelope: OpeEnvelope,
  options: MockInferenceOptions = {},
): Promise<{
  status: number;
  contentType: string;
  body: string;
  usageHeader?: string;
}> {
  if (isGatewayPlaneTaskEnvelope(envelope)) {
    const vllmEnv = options.useEnvVllm === false ? undefined : vllmConfigFromEnv();
    const vllm =
      options.vllm ??
      (vllmEnv
        ? {
            baseUrl: vllmEnv.baseUrl,
            apiKey: vllmEnv.apiKey,
          }
        : undefined);
    return runGatewayPlaneTaskInference(envelope, {
      ...options,
      vllm,
    });
  }

  const gate = validateOpeInferenceEnvelope(envelope);
  if (!gate.ok) {
    return {
      status: gate.status,
      contentType: "application/json",
      body: opeInferenceRejectBody(gate.error, gate.detail),
    };
  }

  const vllmEnv = options.useEnvVllm === false ? undefined : vllmConfigFromEnv();
  const vllm =
    options.vllm ??
    (vllmEnv
      ? {
          baseUrl: vllmEnv.baseUrl,
          apiKey: vllmEnv.apiKey,
        }
      : undefined);

  if (vllm?.baseUrl && options.decryptor) {
    return runOpeInferenceOnEnvelope(envelope, {
      requestId: options.requestId,
      decryptor: options.decryptor,
      vllm,
      taskVllm: options.taskVllm,
      ndjsonStream: options.ndjsonStream,
      onUsage: options.onInference
        ? (env, prefill, completion) => options.onInference!(env, prefill, completion)
        : undefined,
    });
  }

  const convId = envelope.meta?.conversation_id ?? "conv-test";
  const model = envelope.meta?.model ?? "unknown";
  const kvKey = conversationKvKey(convId, model);

  if (!options.decryptor) {
    return {
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "decryptor_required" }),
    };
  }

  let promptTokens: number;
  try {
    const payload = options.decryptor.provider.decryptRequest(
      resolveDecryptHandle(options.decryptor, envelope),
      envelope,
    ) as DecryptedChatPayload;
    promptTokens = promptTokensFromPayload(payload);
  } catch (e) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "decrypt_failed", detail: String(e) }),
    };
  }

  const hash = prefixHash(envelope);
  const { plan, nextState } = planVllmPrefill(kvByConversation.get(kvKey), promptTokens, hash);
  kvByConversation.set(kvKey, nextState);

  if (options.delayMs && options.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }

  const signed =
    options.onInference?.(envelope, plan.coldSuffixTokens) ??
    ({
      report: {
        request_id: crypto.randomUUID(),
        conversation_id: convId,
        engine_id: envelope.engine_id ?? "engine-test",
        prompt_tokens: promptTokens,
        completion_tokens: 5,
        ts: new Date().toISOString(),
      },
      sig: "mock-sig",
    } as SignedUsageReport);

  const usageHeader = Buffer.from(JSON.stringify(signed)).toString("base64url");
  const body =
    options.responseBody?.(envelope, plan.coldSuffixTokens) ??
    JSON.stringify({
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" } }],
      engine_prefill_tokens: plan.coldSuffixTokens,
    });

  return {
    status: 200,
    contentType: CONTENT_TYPE_OPE_JSON,
    body,
    usageHeader,
  };
}

/** Reset KV state between tests. */
export function resetMockInferenceKvState(): void {
  kvByConversation.clear();
}
