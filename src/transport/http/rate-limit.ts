/**
 * Rate Limiter — Transport HTTP (Spec 021-2 / FR-017, D14)
 *
 * In-memory per-key token bucket limiter.
 * Overridable via SEEPIENT_RATE_LIMIT_RPM (default: 300 req/min).
 * 0 disables the limiter.
 */

export interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private defaultRpm: number;

  constructor(defaultRpm = 300) {
    this.defaultRpm = defaultRpm;
  }

  setDefaultRpm(rpm: number): void {
    this.defaultRpm = rpm;
  }

  getDefaultRpm(): number {
    return this.defaultRpm;
  }

  getRpm(): number {
    if (process.env.SEEPIENT_RATE_LIMIT_RPM !== undefined) {
      const parsed = parseInt(process.env.SEEPIENT_RATE_LIMIT_RPM, 10);
      return isNaN(parsed) ? this.defaultRpm : parsed;
    }
    return this.defaultRpm;
  }

  /**
   * Returns how many seconds until at least 1 token is available for this key.
   */
  getRetryAfterSeconds(key: string): number {
    const rpm = this.getRpm();
    if (rpm <= 0) return 0;
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const needed = Math.max(0, 1 - bucket.tokens);
    return Math.max(1, Math.ceil((needed * 60) / rpm));
  }

  /**
   * Consumes 1 token for the specified key.
   * Returns true if allowed, false if rate limit exceeded.
   */
  consume(key: string): boolean {
    const rpm = this.getRpm();
    if (rpm <= 0) {
      return true; // 0 disables rate limiting
    }

    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      // Start with (rpm - 1) tokens since this request consumes the first token
      bucket = { tokens: rpm - 1, lastRefill: now };
      this.buckets.set(key, bucket);
      return true;
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      const refill = (elapsed * rpm) / 60_000;
      bucket.tokens = Math.min(rpm, bucket.tokens + refill);
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  reset(): void {
    this.buckets.clear();
  }
}

export const globalRateLimiter = new RateLimiter();
