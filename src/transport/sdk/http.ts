/**
 * Seepient SDK — HTTP response helpers
 *
 * Converts StreamTextResult into HTTP-friendly SSE responses
 * using the Web API Response and ReadableStream interfaces.
 *
 * Delegates to StreamManager for SSE generation.
 */

import type { StreamTextResult } from "../../foundations/types.js";

// ── SSE options ─────────────────────────────────────────────────────────

export interface SSEOptions {
  headers?: Record<string, string>;
}

// ── SSE helpers ─────────────────────────────────────────────────────────

/**
 * Formats a single Server-Sent Events message.
 *
 * @param event  The SSE event name
 * @param data   The payload (will be JSON-serialised)
 * @returns      A string in SSE wire format: `event: ...\ndata: ...\n\n`
 */
export function createSSEMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── toSSEStream ─────────────────────────────────────────────────────────

/**
 * Converts a StreamTextResult into a SSE-formatted ReadableStream.
 *
 * Delegates to the StreamManager's toSSEStream() for actual event generation.
 * The result's toSSEStream() emits events in the correct order:
 *  - `text`      — incremental text deltas
 *  - `tool_call` — tool invocations
 *  - `tool_result` — tool execution results
 *  - `done`      — final usage and finish reason
 */
export function toSSEStream(
  result: StreamTextResult,
  _options?: SSEOptions,
): ReadableStream {
  return result.toSSEStream();
}

// ── toResponse ──────────────────────────────────────────────────────────

/**
 * Converts a StreamTextResult into a Web API `Response` with an SSE body.
 *
 * Delegates to the StreamManager's toResponse() which sets standard SSE headers:
 *  - `Content-Type: text/event-stream`
 *  - `Cache-Control: no-cache`
 *  - `Connection: keep-alive`
 *
 * @param result   The streaming result to convert
 * @param options  Optional extra headers to merge into the response
 */
export function toResponse(
  result: StreamTextResult,
  options?: SSEOptions,
): Response {
  if (options?.headers) {
    // If custom headers are requested, create a new Response wrapping
    // the StreamManager's SSE stream with merged headers.
    const body = result.toSSEStream();
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...options.headers,
      },
    });
  }
  return result.toResponse();
}
