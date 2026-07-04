/**
 * Seepient Middleware — Auth
 *
 * Simple, composable auth validation middleware.
 */

import type { PipelineContext, Middleware } from "../middleware.js";
import { SeepientError } from "../errors.js";

export interface AuthOptions {
  /** Validate the request context. Throw or return false to reject. */
  validate: (ctx: PipelineContext) => boolean | Promise<boolean>;
  /** Error message on rejection (default: "Unauthorized") */
  errorMessage?: string;
}

/**
 * Create an auth middleware.
 *
 * @example
 * ```ts
 * const mw = authMiddleware({
 *   validate: (ctx) => !!ctx.metadata.apiKey,
 *   errorMessage: "API key required",
 * });
 * ```
 */
export function authMiddleware(options: AuthOptions): Middleware {
  const { validate } = options;
  const errorMessage = options.errorMessage ?? "Unauthorized";

  return async (ctx: PipelineContext, next: () => Promise<void>) => {
    const allowed = await validate(ctx);
    if (!allowed) {
      throw new SeepientError(errorMessage, "UNAUTHORIZED", false);
    }
    await next();
  };
}
