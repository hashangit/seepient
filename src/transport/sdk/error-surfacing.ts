/**
 * Centralized Loop Error Surfacing — Transport (spec 021 hardening).
 *
 * Converts internal AgentLoopResult error states into typed SeepientError
 * instances for one-shot batch throwing and streaming onError callbacks.
 * Abort signals are strictly non-error lifecycle events.
 */
import type { AgentLoopResult } from "../../domain/agent-loop.js";
import { SeepientError } from "../../foundations/errors.js";

/**
 * Extract a typed SeepientError from an AgentLoopResult if an execution
 * failure occurred. Returns null for normal completions and user aborts.
 */
export function extractLoopError(result: AgentLoopResult): SeepientError | null {
  if (
    result.error &&
    result.finishReason !== "aborted" &&
    result.error.code !== "ABORTED"
  ) {
    return new SeepientError(
      result.error.message || `Agent run failed: ${result.error.code}`,
      result.error.code,
      result.error.retryable ?? false,
    );
  }
  return null;
}

/**
 * Surface loop errors for one-shot synchronous/batch operations (chat, askSeepient).
 * Throws typed SeepientError if an error occurred; no-op otherwise.
 */
export function surfaceLoopError(result: AgentLoopResult): void {
  const err = extractLoopError(result);
  if (err) {
    throw err;
  }
}
