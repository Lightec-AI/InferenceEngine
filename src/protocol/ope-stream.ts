/** OPE §7 streaming frames (NDJSON). */

export const CONTENT_TYPE_OPE_JSON_STREAM = "application/ope+json-stream";

export type OpeStreamStatusPhase =
  | "mode"
  | "search_query"
  | "fetch_page"
  | "process_pages"
  | "thinking"
  | "streaming";

export type OpeStreamFrame =
  | { ope_stream: "1.0"; server_share: string }
  | { ope_stream: "1.0"; seq: number; ciphertext: string; final?: boolean }
  | { ope_stream: "1.0"; type: "trailer"; usage_report?: string }
  | {
      ope_stream: "1.0";
      type: "status";
      phase: OpeStreamStatusPhase;
      detail?: string;
      mode?: string;
    };

export function encodeOpeStatusLine(
  phase: OpeStreamStatusPhase,
  opts?: { detail?: string; mode?: string },
): Buffer {
  return encodeOpeStreamLine({
    ope_stream: "1.0",
    type: "status",
    phase,
    ...(opts?.detail ? { detail: opts.detail } : {}),
    ...(opts?.mode ? { mode: opts.mode } : {}),
  });
}

export function encodeOpeStreamLine(frame: OpeStreamFrame): Buffer {
  return Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
}

export function parseOpeStreamLine(line: string): OpeStreamFrame | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    if (j.ope_stream !== "1.0") return null;
    if (j.type === "trailer") {
      return {
        ope_stream: "1.0",
        type: "trailer",
        usage_report: typeof j.usage_report === "string" ? j.usage_report : undefined,
      };
    }
    if (j.type === "status" && typeof j.phase === "string") {
      return {
        ope_stream: "1.0",
        type: "status",
        phase: j.phase as OpeStreamStatusPhase,
        detail: typeof j.detail === "string" ? j.detail : undefined,
        mode: typeof j.mode === "string" ? j.mode : undefined,
      };
    }
    if (typeof j.server_share === "string") {
      return { ope_stream: "1.0", server_share: j.server_share };
    }
    if (typeof j.seq === "number" && typeof j.ciphertext === "string") {
      return {
        ope_stream: "1.0",
        seq: j.seq,
        ciphertext: j.ciphertext,
        final: j.final === true,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function isOpeStreamContentType(contentType: string | null | undefined): boolean {
  return (contentType ?? "").includes(CONTENT_TYPE_OPE_JSON_STREAM);
}
