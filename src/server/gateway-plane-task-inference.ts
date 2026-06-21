import { randomUUID } from "node:crypto";

import type { OpeEnvelope, SignedUsageReport } from "../protocol/types.js";
import {
  completeVllmChatCompletion,
  resolveVllmBaseUrlForModel,
  type TaskVllmRouting,
} from "../upstream/vllm-chat.js";
import { normalizeVllmMessages } from "../upstream/vllm-multimodal.js";
import { logEngineVllmUpstreamError } from "../ops/engine-events.js";

export const GATEWAY_PLANE_TASK_ENC = "gateway-plane-task";

export interface GatewayPlaneTaskInferenceOptions {
  requestId?: string;
  vllm?: { baseUrl: string; apiKey?: string; fetchImpl?: typeof fetch };
  taskVllm?: TaskVllmRouting;
  useEnvVllm?: boolean;
  onInference?: (
    envelope: OpeEnvelope,
    prefillTokens: number,
    completionTokens?: number,
  ) => SignedUsageReport;
}

function tokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function stripModelProvider(model: string): string {
  const at = model.indexOf("@");
  return at >= 0 ? model.slice(0, at) : model;
}

export function isGatewayPlaneTaskEnvelope(envelope: OpeEnvelope): boolean {
  return envelope.enc === GATEWAY_PLANE_TASK_ENC;
}

export function validateGatewayPlaneTaskEnvelope(
  envelope: OpeEnvelope,
): { ok: true } | { ok: false; status: number; error: string; detail?: string } {
  if (!isGatewayPlaneTaskEnvelope(envelope)) {
    return { ok: false, status: 400, error: "not_gateway_plane_task" };
  }
  if (!envelope.engine_id?.trim()) {
    return { ok: false, status: 400, error: "engine_id_required" };
  }
  const model = envelope.meta?.model?.trim();
  if (!model) {
    return { ok: false, status: 400, error: "model_required" };
  }
  const task = envelope.meta?.gateway_task;
  if (!task || !Array.isArray(task.messages) || task.messages.length === 0) {
    return { ok: false, status: 400, error: "gateway_task_messages_required" };
  }
  for (const m of task.messages) {
    if (!m || typeof m !== "object") {
      return { ok: false, status: 400, error: "invalid_gateway_task_message" };
    }
    if (typeof m.role !== "string" || typeof m.content !== "string") {
      return { ok: false, status: 400, error: "invalid_gateway_task_message" };
    }
  }
  return { ok: true };
}

function taskRoutingFromOptions(options: GatewayPlaneTaskInferenceOptions): TaskVllmRouting | null {
  const task = options.taskVllm;
  if (!task?.baseUrl || !task.modelId) return null;
  return task;
}

/** Gateway-origin background inference on the attested engine plane (no user E2E envelope). */
export async function runGatewayPlaneTaskInference(
  envelope: OpeEnvelope,
  options: GatewayPlaneTaskInferenceOptions = {},
): Promise<{
  status: number;
  contentType: string;
  body: string;
  usageHeader?: string;
}> {
  const gate = validateGatewayPlaneTaskEnvelope(envelope);
  if (!gate.ok) {
    return {
      status: gate.status,
      contentType: "application/json",
      body: JSON.stringify({ error: gate.error, detail: gate.detail }),
    };
  }

  const vllmEnv = options.useEnvVllm === false ? undefined : options.vllm;
  const mainBaseUrl = vllmEnv?.baseUrl;
  if (!mainBaseUrl) {
    return {
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "vllm_not_configured" }),
    };
  }

  const model = stripModelProvider(envelope.meta!.model!);
  const taskPayload = envelope.meta!.gateway_task!;
  const routed = resolveVllmBaseUrlForModel(model, { baseUrl: mainBaseUrl, apiKey: vllmEnv?.apiKey }, taskRoutingFromOptions(options));
  const messages = normalizeVllmMessages(taskPayload.messages);
  const promptTokens = tokensFromText(messages.map((m) => String(m.content ?? "")).join(" "));

  try {
    const content = await completeVllmChatCompletion({
      baseUrl: routed.baseUrl,
      model: routed.model,
      messages,
      apiKey: routed.apiKey,
      maxTokens: taskPayload.max_tokens,
      temperature: taskPayload.temperature,
      fetchImpl: vllmEnv?.fetchImpl,
    });

    const completionTokens = tokensFromText(content || "x");
    const signed =
      options.onInference?.(envelope, promptTokens, completionTokens) ??
      ({
        report: {
          request_id: options.requestId ?? randomUUID(),
          conversation_id: envelope.meta?.conversation_id ?? "gateway-task",
          engine_id: envelope.engine_id ?? "engine",
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          ts: new Date().toISOString(),
        },
        sig: "gateway-plane-task",
      } as SignedUsageReport);

    const usageHeader = Buffer.from(JSON.stringify(signed)).toString("base64url");
    const body = JSON.stringify({
      object: "chat.completion",
      model: routed.model,
      choices: [{ message: { role: "assistant", content } }],
    });

    return {
      status: 200,
      contentType: "application/json",
      body,
      usageHeader,
    };
  } catch (e) {
    logEngineVllmUpstreamError(options.requestId, undefined, e);
    return {
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "vllm_upstream_failed", detail: String(e) }),
    };
  }
}
