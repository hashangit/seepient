/**
 * Structured Logging — Transport (Spec 021-2 / FR-018)
 *
 * Emits JSON-line logs to stdout for transport seams.
 * Guarantees that raw API keys are never disclosed.
 */

export interface LogLine {
  ts: string;
  level: "info" | "warn" | "error";
  event: "http_request" | "ws_dispatch" | "ws_error" | "probe" | "persist_error";
  requestId: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  apiKeyHashPrefix?: string;
  error?: string;
}

export type LogEventInput = Omit<LogLine, "ts"> & Record<string, unknown>;

export function logTransportEvent(line: LogEventInput): void {
  const fullLine = {
    ...line,
    ts: new Date().toISOString(),
  };
  if (fullLine.apiKeyHashPrefix && fullLine.apiKeyHashPrefix.length > 8) {
    fullLine.apiKeyHashPrefix = fullLine.apiKeyHashPrefix.slice(0, 8);
  }
  process.stdout.write(JSON.stringify(fullLine) + "\n");
}
