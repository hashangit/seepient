/**
 * Seepient Middleware — Logging
 *
 * Logs request start and response finish with duration, model, steps, and usage.
 */

import type { PipelineContext, Middleware } from "../middleware.js";

export interface LoggingOptions {
  /** Log at request start (default: true) */
  logRequest?: boolean;
  /** Log at response finish (default: true) */
  logResponse?: boolean;
  /** Custom logger (default: console.log) */
  logger?: (message: string) => void;
}

/**
 * Create a logging middleware.
 *
 * @example
 * ```ts
 * const mw = loggingMiddleware({ logRequest: true, logResponse: true });
 * ```
 */
export function loggingMiddleware(options?: LoggingOptions): Middleware {
  const logRequest = options?.logRequest ?? true;
  const logResponse = options?.logResponse ?? true;
  const log = options?.logger ?? console.log;

  return async (ctx: PipelineContext, next: () => Promise<void>) => {
    if (logRequest) {
      log(
        `[seepient] request=${ctx.requestId} model=${ctx.model} messages=${ctx.messages.length} start`,
      );
    }

    await next();

    if (logResponse && ctx.result) {
      const durationMs = Date.now() - ctx.startedAt;
      log(
        `[seepient] request=${ctx.requestId} model=${ctx.model} finish=${ctx.result.finishReason} steps=${ctx.result.steps.length} tokens=${ctx.result.usage.totalTokens} duration=${durationMs}ms`,
      );
    }
  };
}
