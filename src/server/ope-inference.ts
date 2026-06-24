import { createHash } from "node:crypto";

import { conversationKvKey, planVllmPrefill } from "../prefill.js";
import type { OpeEnvelope, SignedUsageReport } from "../protocol/types.js";
import {
  CONTENT_TYPE_OPE_JSON_STREAM,
  encodeOpeStatusLine,
  encodeOpeStreamLine,
} from "../protocol/ope-stream.js";
import { CONTENT_TYPE_OPE_JSON } from "../protocol/types.js";
import {
  clampVllmMaxTokens,
  resolveVllmBaseUrlForModel,
  streamVllmChatCompletion,
  VLLM_OUTPUT_TOKEN_LIMIT_NOTICE,
  type VllmStreamOptions,
} from "../upstream/vllm-chat.js";
import {
  estimatePromptTokensFromMessages,
  normalizeVllmMessages,
} from "../upstream/vllm-multimodal.js";
import type { MockInferenceDecryptor } from "./mock-inference.js";
import { logEngineVllmUpstreamError } from "../ops/engine-events.js";
import { opeInferenceRejectBody, validateOpeInferenceEnvelope } from "./ope-inference-gate.js";

export interface OpeInferenceDecryptor extends MockInferenceDecryptor {}

function httpStatusFromVllmError(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const match = /vLLM HTTP (\d{3})/i.exec(msg);
  return match ? Number(match[1]) : undefined;
}

export interface OpeNdjsonStreamWriter {
  write(chunk: Buffer): void;
  end(): void;
}

export interface OpeInferenceOptions {
  requestId?: string;
  decryptor?: OpeInferenceDecryptor;
  vllm?: Omit<VllmStreamOptions, "messages" | "model"> & { fetchImpl?: typeof fetch };
  taskVllm?: import("../upstream/vllm-chat.js").TaskVllmRouting;
  onUsage?: (envelope: OpeEnvelope, prefillTokens: number, completionTokens: number) => SignedUsageReport;
  chunkChars?: number;
  /** When set, emit OPE §7 NDJSON frames as ciphertext is produced (stream cipher). */
  ndjsonStream?: OpeNdjsonStreamWriter;
}

interface DecryptedChatPayload {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  max_tokens?: number;
}

function tokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function promptTokensFromPayload(payload: DecryptedChatPayload): number {
  const messages = normalizeVllmMessages(payload.messages ?? []);
  return estimatePromptTokensFromMessages(messages);
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
  const gate = validateOpeInferenceEnvelope(envelope);
  if (!gate.ok) {
    return {
      status: gate.status,
      contentType: "application/json",
      body: opeInferenceRejectBody(gate.error, gate.detail),
    };
  }

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

  const messages = normalizeVllmMessages(payload.messages ?? []);

  const provider = options.decryptor.provider;
  const { session, serverShare } = provider.beginResponse(options.decryptor.handle, envelope);
  const chunkChars = options.chunkChars ?? 8;
  const chunks: string[] = [];
  let pending = "";
  let fullText = "";
  let seq = 0;
  const finishState: { reason?: string } = {};
  const payloadMaxTokens =
    typeof payload.max_tokens === "number" && payload.max_tokens > 0
      ? clampVllmMaxTokens(payload.max_tokens)
      : undefined;
  const streamOut = options.ndjsonStream;

  const emitEncryptedPiece = (piece: string, final: boolean) => {
    const ciphertext = provider.encryptResponseChunk(session, seq, Buffer.from(piece, "utf8"));
    if (streamOut) {
      streamOut.write(encodeOpeStreamLine({ ope_stream: "1.0", seq, ciphertext, final }));
    } else {
      chunks.push(ciphertext);
    }
    seq += 1;
  };

  if (streamOut) {
    streamOut.write(encodeOpeStreamLine({ ope_stream: "1.0", server_share: serverShare }));
  }

  try {
    const routed = resolveVllmBaseUrlForModel(
      model,
      { baseUrl: options.vllm.baseUrl, apiKey: options.vllm.apiKey },
      options.taskVllm,
    );
    for await (const delta of streamVllmChatCompletion({
      ...options.vllm,
      baseUrl: routed.baseUrl,
      apiKey: routed.apiKey,
      model: routed.model,
      messages,
      maxTokens: payloadMaxTokens ?? options.vllm?.maxTokens,
      finishState,
    })) {
      fullText += delta;
      pending += delta;
      while (pending.length >= chunkChars) {
        const piece = pending.slice(0, chunkChars);
        pending = pending.slice(chunkChars);
        emitEncryptedPiece(piece, false);
      }
    }
    if (finishState.reason === "length" && !fullText.includes("output token limit")) {
      fullText += VLLM_OUTPUT_TOKEN_LIMIT_NOTICE;
      pending += VLLM_OUTPUT_TOKEN_LIMIT_NOTICE;
    }
    if (pending.length > 0) {
      emitEncryptedPiece(pending, true);
    } else if (!fullText.trim()) {
      const reason = finishState.reason ?? "unknown";
      logEngineVllmUpstreamError(
        options.requestId,
        undefined,
        new Error(`vLLM empty completion (finish_reason=${reason})`),
      );
      if (streamOut) {
        streamOut.write(
          encodeOpeStatusLine("streaming", { detail: `empty_completion:${reason}` }),
        );
      }
    }
  } catch (e) {
    provider.freeResponse(session);
    logEngineVllmUpstreamError(options.requestId, httpStatusFromVllmError(e), e);
    if (streamOut) {
      streamOut.end();
      return {
        status: 502,
        contentType: CONTENT_TYPE_OPE_JSON_STREAM,
        body: "",
      };
    }
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

  if (streamOut) {
    streamOut.write(
      encodeOpeStreamLine({ ope_stream: "1.0", type: "trailer", usage_report: usageHeader }),
    );
    streamOut.end();
    return {
      status: 200,
      contentType: CONTENT_TYPE_OPE_JSON_STREAM,
      body: "",
      usageHeader,
    };
  }

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
