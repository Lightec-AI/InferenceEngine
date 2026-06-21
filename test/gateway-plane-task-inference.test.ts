import { describe, expect, it, vi } from "vitest";

import type { OpeEnvelope } from "../src/protocol/types.js";
import {
  GATEWAY_PLANE_TASK_ENC,
  runGatewayPlaneTaskInference,
  validateGatewayPlaneTaskEnvelope,
} from "../src/server/gateway-plane-task-inference.js";

describe("gateway-plane-task inference", () => {
  const envelope: OpeEnvelope = {
    ope_version: "1.0",
    alg: "none",
    enc: GATEWAY_PLANE_TASK_ENC,
    kid: "gateway",
    recipient: "teechat-engine",
    ts: new Date().toISOString(),
    nonce: "n1",
    payload_hash: "",
    engine_id: "engine-prod-1",
    meta: {
      model: "google/gemma-4-E4B-it@teechat",
      conversation_id: "gateway-task:test",
      gateway_task: {
        messages: [{ role: "user", content: "Say hi" }],
        max_tokens: 32,
        temperature: 0.2,
      },
    },
  };

  it("validates gateway task envelopes", () => {
    expect(validateGatewayPlaneTaskEnvelope(envelope).ok).toBe(true);
  });

  it("routes task model to task vLLM base URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: " hello " } }],
      }),
    });

    const result = await runGatewayPlaneTaskInference(envelope, {
      vllm: { baseUrl: "http://127.0.0.1:8000/v1", fetchImpl },
      taskVllm: { baseUrl: "http://127.0.0.1:8001/v1", modelId: "google/gemma-4-E4B-it" },
    });

    expect(result.status).toBe(200);
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://127.0.0.1:8001/v1/chat/completions");
    const body = JSON.parse(result.body) as { choices?: Array<{ message?: { content?: string } }> };
    expect(body.choices?.[0]?.message?.content).toBe("hello");
  });
});
