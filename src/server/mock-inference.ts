import http from "node:http";
import { createHash } from "node:crypto";

import type { CryptoProvider } from "../crypto/provider.js";
import { conversationKvKey, planVllmPrefill } from "../prefill.js";
import type { OpeEnvelope, SignedUsageReport } from "../protocol/types.js";
import { HEADER_USAGE_REPORT, INFERENCE_PATH } from "../protocol/types.js";
import {
  opeInferenceRejectBody,
  validateOpeInferenceContentType,
  validateOpeInferenceEnvelope,
} from "./ope-inference-gate.js";

/** Real-decryption hook: the engine's live epoch handle + crypto provider. */
export interface MockInferenceDecryptor {
  handle: number;
  provider: CryptoProvider;
}

interface DecryptedChatPayload {
  messages?: Array<{ role?: string; content?: unknown }>;
}

function tokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Prompt tokens from the *decrypted* payload (real engine path). */
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

/** Dev/test HTTP server implementing POST /v1/ope/inference. */
export function createMockInferenceServer(
  onInference?: (envelope: OpeEnvelope, prefillTokens: number) => SignedUsageReport,
  options: { decryptor?: MockInferenceDecryptor } = {},
): Promise<{ server: http.Server; baseUrl: string }> {
  const kvByConversation = new Map<string, { prefixHash: string; prefilledTokens: number }>();
  const decryptor = options.decryptor;

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
        const contentTypeGate = validateOpeInferenceContentType(req.headers["content-type"]);
        if (!contentTypeGate.ok) {
          res.statusCode = contentTypeGate.status;
          res.end(opeInferenceRejectBody(contentTypeGate.error));
          return;
        }

        let envelope: OpeEnvelope;
        try {
          envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OpeEnvelope;
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }

        const envelopeGate = validateOpeInferenceEnvelope(envelope);
        if (!envelopeGate.ok) {
          res.statusCode = envelopeGate.status;
          res.end(opeInferenceRejectBody(envelopeGate.error, envelopeGate.detail));
          return;
        }

        if (!decryptor) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "decryptor_required" }));
          return;
        }

        const convId = envelope.meta?.conversation_id ?? "conv-test";
        const model = envelope.meta?.model ?? "unknown";
        const kvKey = conversationKvKey(convId, model);

        let promptTokens: number;
        try {
          const payload = decryptor.provider.decryptRequest(
            decryptor.handle,
            envelope,
          ) as DecryptedChatPayload;
          promptTokens = promptTokensFromPayload(payload);
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "decrypt_failed", detail: String(e) }));
          return;
        }

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
