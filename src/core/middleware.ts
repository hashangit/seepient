/**
 * Seepient Middleware Pipeline
 *
 * Composable middleware chain that wraps `runAgentLoop`.
 * Follows the `(ctx, next) => Promise<void>` pattern for cross-cutting
 * concerns like logging, rate limiting, and auth.
 */

import type { Message, Usage, StepResult, ToolCall } from "./types.js";
import type { LLMProvider } from "../providers/types.js";
import type { ToolDefinition } from "../tools/interface.js";

// ── Pipeline Context ─────────────────────────────────────────────────────

export interface PipelineContext {
  /** Unique ID for this request */
  requestId: string;
  /** Input messages (mutable — middleware can inspect or modify) */
  messages: Message[];
  /** Resolved provider */
  provider: LLMProvider;
  /** Model identifier */
  model: string;
  /** Tool definitions available for this request */
  toolDefs: ToolDefinition[];
  /** Adapter-specific metadata (e.g., userId, source) */
  metadata: Record<string, unknown>;
  /** Result populated after the loop runs */
  result?: {
    messages: Message[];
    steps: StepResult[];
    toolCalls: ToolCall[];
    usage: Usage;
    contextTokens: number;
    finishReason: string;
  };
  /** Abort signal */
  signal?: AbortSignal;
  /** Timestamp when the pipeline started */
  startedAt: number;
}

// ── Middleware Type ──────────────────────────────────────────────────────

export type Middleware = (
  ctx: PipelineContext,
  next: () => Promise<void>,
) => Promise<void>;

// ── Compose ─────────────────────────────────────────────────────────────

/**
 * Compose an array of middleware into a single function.
 *
 * Each middleware receives `(ctx, next)`. Calling `next()` invokes the
 * next middleware in the chain (or the final handler if last). Errors
 * propagate upward so callers can handle them (e.g., auth rejection).
 *
 * @param middlewares - Ordered list of middleware functions
 * @returns A function that runs the full chain
 */
export function compose(
  middlewares: Middleware[],
): (ctx: PipelineContext, finalHandler: () => Promise<void>) => Promise<void> {
  if (middlewares.length === 0) {
    return (_ctx, finalHandler) => finalHandler();
  }

  return (ctx, finalHandler) => {
    let index = -1;

    async function dispatch(i: number): Promise<void> {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;

      if (i === middlewares.length) {
        return finalHandler();
      }

      const fn = middlewares[i]!;
      return fn(ctx, () => dispatch(i + 1));
    }

    return dispatch(0);
  };
}
