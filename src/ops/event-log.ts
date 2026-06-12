export type LogLevel = "debug" | "info" | "warn" | "error";

export type EventLogFields = Record<string, string | number | boolean | null | undefined>;

export interface EventLogRecord {
  ts: string;
  level: LogLevel;
  component: string;
  event: string;
  fields?: EventLogFields;
}

export type EventLogSink = (line: string) => void;

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let sink: EventLogSink = (line) => {
  process.stderr.write(`${line}\n`);
};

let minLevel: LogLevel = "info";

export function resetEventLogForTests(): void {
  sink = (line) => {
    process.stderr.write(`${line}\n`);
  };
  minLevel = "info";
}

export function setEventLogSink(next: EventLogSink): void {
  sink = next;
}

export function setEventLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function eventLogLevelFromEnv(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = (env.TEECHAT_LOG_LEVEL ?? "info").trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

export function configureEventLogFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  minLevel = eventLogLevelFromEnv(env);
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minLevel];
}

function compactFields(fields: EventLogFields | undefined): EventLogFields | undefined {
  if (!fields) return undefined;
  const out: EventLogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function logEvent(
  level: LogLevel,
  component: string,
  event: string,
  fields?: EventLogFields,
): EventLogRecord | null {
  if (!shouldLog(level)) return null;
  const record: EventLogRecord = {
    ts: new Date().toISOString(),
    level,
    component,
    event,
    fields: compactFields(fields),
  };
  sink(JSON.stringify(record));
  return record;
}

export function parseGatewayHost(gatewayBaseUrl: string): string | undefined {
  try {
    return new URL(gatewayBaseUrl).hostname || undefined;
  } catch {
    return undefined;
  }
}
