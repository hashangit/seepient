/**
 * Seepient Middleware — Rate Limiting
 *
 * Token bucket rate limiter per key. Throws on limit exceeded.
 */

import type { PipelineContext, Middleware } from "../middleware.js";
import { SeepientError } from "../errors.js";

export interface RateLimitOptions {
  /** Maximum requests allowed per window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Extract a key from context for per-key limiting (default: "global") */
  keyExtractor?: (ctx: PipelineContext) => string;
}

interface Bucket {
  tokens: number;
  resetAt: number;
}

/**
 * Create a rate limiting middleware using a token bucket algorithm.
 *
 * @example
 * ```ts
 * const mw = rateLimitMiddleware({
 *   maxRequests: 60,
 *   windowMs: 60_000,
 *   keyExtractor: (ctx) => ctx.metadata.userId as string,
 * });
 * ```
 */
export function rateLimitMiddleware(options: RateLimitOptions): Middleware {
  const { maxRequests, windowMs } = options;
  const keyExtractor = options.keyExtractor ?? (() => "global");
  const buckets = new Map<string, Bucket>();

  return async (ctx: PipelineContext, next: () => Promise<void>) => {
    const key = keyExtractor(ctx);
    const now = Date.now();

    let bucket = buckets.get(key);

    // Create or reset expired bucket
    if (!bucket || now >= bucket.resetAt) {
      bucket = { tokens: maxRequests, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    if (bucket.tokens <= 0) {
      throw new SeepientError(
        `Rate limit exceeded for key "${key}": max ${maxRequests} requests per ${windowMs}ms`,
        "RATE_LIMITED",
        false,
      );
    }

    bucket.tokens -= 1;
    await next();
  };
}
