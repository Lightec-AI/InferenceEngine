import type { OpeEnvelope, OpeE2eDescriptor } from "../protocol/types.js";
import { CONTENT_TYPE_OPE_JSON } from "../protocol/types.js";

export type OpeInferenceGateError =
  | "content_type_must_be_ope_json"
  | "e2e_envelope_required"
  | "e2e_ephemeral_epoch_required"
  | "plaintext_payload_forbidden"
  | "ciphertext_required"
  | "decryptor_required";

function parseE2e(envelope: OpeEnvelope): OpeE2eDescriptor | null {
  const raw = envelope.e2e;
  if (!raw || typeof raw !== "object") return null;
  const e = raw as OpeE2eDescriptor;
  if (
    typeof e.ephemeral_epoch !== "string" ||
    typeof e.engine_mlkem_encap !== "string" ||
    typeof e.engine_x25519 !== "string"
  ) {
    return null;
  }
  return e;
}

function hasForbiddenPlaintext(envelope: OpeEnvelope): boolean {
  const rec = envelope as unknown as Record<string, unknown>;
  if ("payload" in rec && rec.payload !== undefined && rec.payload !== null) {
    return true;
  }
  if (envelope.enc === "none") return true;
  return false;
}

export function validateOpeInferenceContentType(
  contentType: string | undefined,
): { ok: true } | { ok: false; status: 415; error: "content_type_must_be_ope_json" } {
  const ct = contentType ?? "";
  if (!ct.includes(CONTENT_TYPE_OPE_JSON)) {
    return { ok: false, status: 415, error: "content_type_must_be_ope_json" };
  }
  return { ok: true };
}

/** Engine plane accepts only hybrid E2E OPE envelopes (same shape as gateway). */
export function validateOpeInferenceEnvelope(
  envelope: OpeEnvelope,
): { ok: true } | { ok: false; status: number; error: OpeInferenceGateError; detail?: string } {
  if (hasForbiddenPlaintext(envelope)) {
    return { ok: false, status: 400, error: "plaintext_payload_forbidden" };
  }
  if (envelope.enc !== "e2e-hybrid-pq" || !envelope.engine_id) {
    return { ok: false, status: 400, error: "e2e_envelope_required" };
  }
  if (!envelope.ciphertext?.length || !envelope.iv?.length) {
    return { ok: false, status: 400, error: "ciphertext_required" };
  }
  if (!parseE2e(envelope)) {
    return { ok: false, status: 400, error: "e2e_ephemeral_epoch_required" };
  }
  return { ok: true };
}

export function opeInferenceRejectBody(error: string, detail?: string): string {
  return JSON.stringify(detail !== undefined ? { error, detail } : { error });
}
