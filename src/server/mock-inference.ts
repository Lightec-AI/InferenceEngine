import http from "node:http";
import { createHash } from "node:crypto";

import { conversationKvKey, planVllmPrefill } from "../prefill.js";
import type { OpeEnvelope, SignedUsageReport } from "../protocol/types.js";
import { HEADER_USAGE_REPORT, INFERENCE_PATH } from "../protocol/types.js";

function estimatePromptTokens(envelope: OpeEnvelope): number {
  const raw = envelope.ciphertext ?? "";
  return Math.max(1, Math.ceil(raw.length / 4));
}

function prefixHash(envelope: OpeEnvelope): string {
  return createHash("sha256")
    .update(envelope.meta?.conversation_id ?? "")
    .digest("hex");
}

/** Dev/test HTTP server implementing POST /v1/ope/inference. */
export function createMockInferenceServer(
  onInference?: (envelope: OpeEnvelope, prefillTokens: number) => SignedUsageReport,
): Promise<{ server: http.Server; baseUrl: string }> {
  const kvByConversation = new Map<string, { prefixHash: string; prefilledTokens: number }>();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== INFERENCE_PATH) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        let envelope: OpeEnvelope;
        try {
          envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OpeEnvelope;
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }

        const convId = envelope.meta?.conversation_id ?? "conv-test";
        const model = envelope.meta?.model ?? "unknown";
        const kvKey = conversationKvKey(convId, model);
        const promptTokens = estimatePromptTokens(envelope);
        const hash = prefixHash(envelope);
        const { plan, nextState } = planVllmPrefill(kvByConversation.get(kvKey), promptTokens, hash);
        kvByConversation.set(kvKey, nextState);

        const signed =
          onInference?.(envelope, plan.coldSuffixTokens) ??
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

        const usageB64 = Buffer.from(JSON.stringify(signed)).toString("base64url");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.setHeader(HEADER_USAGE_REPORT, usageB64);
        res.end(
          JSON.stringify({
            object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            engine_prefill_tokens: plan.coldSuffixTokens,
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no address"));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}
