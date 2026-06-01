import { createHash } from "node:crypto";

import { conversationKvKey, planVllmPrefill } from "../prefill.js";
import type { OpeEnvelope, SignedUsageReport } from "../protocol/types.js";
import { CONTENT_TYPE_OPE_JSON } from "../protocol/types.js";
import { streamVllmChatCompletion, type VllmStreamOptions } from "../upstream/vllm-chat.js";
import type { MockInferenceDecryptor } from "./mock-inference.js";

export interface OpeInferenceDecryptor extends MockInferenceDecryptor {}

export interface OpeInferenceOptions {
  decryptor?: OpeInferenceDecryptor;
  vllm?: Omit<VllmStreamOptions, "messages" | "model"> & { fetchImpl?: typeof fetch };
  onUsage?: (envelope: OpeEnvelope, prefillTokens: number, completionTokens: number) => SignedUsageReport;
  chunkChars?: number;
}

interface DecryptedChatPayload {
  model?: string;
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

function stripModelProvider(model: string): string {
  const at = model.indexOf("@");
  return at >= 0 ? model.slice(0, at) : model;
}

const kvByConversation = new Map<string, { prefixHash: string; prefilledTokens: number }>();

export function resetOpeInferenceKvState(): void {
  kvByConversation.clear();
}

/**
 * Production inference path: decrypt OPE request → vLLM stream → encrypt OPE response chunks.
 */
export async function runOpeInferenceOnEnvelope(
  envelope: OpeEnvelope,
  options: OpeInferenceOptions = {},
): Promise<{
  status: number;
  contentType: string;
  body: string;
  usageHeader?: string;
}> {
  if (!options.decryptor) {
    return {
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "decryptor_required" }),
    };
  }
  if (!options.vllm?.baseUrl) {
    return {
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "vllm_not_configured" }),
    };
  }

  let payload: DecryptedChatPayload;
  try {
    payload = options.decryptor.provider.decryptRequest(
      options.decryptor.handle,
      envelope,
    ) as DecryptedChatPayload;
  } catch (e) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "decrypt_failed", detail: String(e) }),
    };
  }

  const convId = envelope.meta?.conversation_id ?? "conv";
  const model = stripModelProvider(payload.model ?? envelope.meta?.model ?? "unknown");
  const kvKey = conversationKvKey(convId, model);
  const promptTokens = promptTokensFromPayload(payload);
  const hash = prefixHash(envelope);
  const { plan, nextState } = planVllmPrefill(kvByConversation.get(kvKey), promptTokens, hash);
  kvByConversation.set(kvKey, nextState);

  const messages = (payload.messages ?? []).map((m) => ({
    role: m.role ?? "user",
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
  }));

  const provider = options.decryptor.provider;
  const { session, serverShare } = provider.beginResponse(options.decryptor.handle, envelope);
  const chunkChars = options.chunkChars ?? 64;
  const chunks: string[] = [];
  let pending = "";
  let fullText = "";

  try {
    for await (const delta of streamVllmChatCompletion({
      ...options.vllm,
      model,
      messages,
    })) {
      fullText += delta;
      pending += delta;
      while (pending.length >= chunkChars) {
        const piece = pending.slice(0, chunkChars);
        pending = pending.slice(chunkChars);
        chunks.push(provider.encryptResponseChunk(session, chunks.length, Buffer.from(piece, "utf8")));
      }
    }
    if (pending.length > 0) {
      chunks.push(
        provider.encryptResponseChunk(session, chunks.length, Buffer.from(pending, "utf8")),
      );
    }
  } catch (e) {
    provider.freeResponse(session);
    return {
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "vllm_upstream_failed", detail: String(e) }),
    };
  }

  provider.freeResponse(session);

  const completionTokens = Math.max(1, tokensFromText(fullText || "x"));
  const signed =
    options.onUsage?.(envelope, plan.coldSuffixTokens, completionTokens) ??
    ({
      report: {
        request_id: crypto.randomUUID(),
        conversation_id: convId,
        engine_id: envelope.engine_id ?? "engine",
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        ts: new Date().toISOString(),
      },
      sig: "mock-sig",
    } as SignedUsageReport);

  const usageHeader = Buffer.from(JSON.stringify(signed)).toString("base64url");
  const body = JSON.stringify({
    server_share: serverShare,
    chunks,
    engine_prefill_tokens: plan.coldSuffixTokens,
  });

  return {
    status: 200,
    contentType: CONTENT_TYPE_OPE_JSON,
    body,
    usageHeader,
  };
}
