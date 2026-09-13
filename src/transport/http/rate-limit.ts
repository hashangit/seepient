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
  static readonly MAX_BUCKETS = 10_000;
  static readonly IDLE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  private buckets = new Map<string, TokenBucket>();
  private defaultRpm: number;
  private maxBuckets: number;
  /**
   * W161: optional live rpm source (e.g. the settings manager) — re-read per
   * consume so a settings PATCH takes effect without a restart.
   */
  private rpmProvider?: () => number | undefined;

  constructor(
    defaultRpm = 300,
    rpmProvider?: () => number | undefined,
    maxBuckets = RateLimiter.MAX_BUCKETS,
  ) {
    this.defaultRpm = defaultRpm;
    this.rpmProvider = rpmProvider;
    this.maxBuckets = maxBuckets;
  }

  get size(): number {
    return this.buckets.size;
  }

  private prune(now: number): void {
    const cutoff = now - RateLimiter.IDLE_TTL_MS;
    for (const [k, b] of this.buckets) {
      if (b.lastRefill < cutoff) {
        this.buckets.delete(k);
      }
    }
    if (this.buckets.size >= this.maxBuckets) {
      const excess = this.buckets.size - this.maxBuckets + 1;
      let count = 0;
      for (const k of this.buckets.keys()) {
        this.buckets.delete(k);
        count++;
        if (count >= excess) break;
      }
    }
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
    // W161: re-read the live settings value on every lookup.
    return this.rpmProvider?.() ?? this.defaultRpm;
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
      if (this.buckets.size >= this.maxBuckets) {
        this.prune(now);
      }
      // Start with (rpm - 1) tokens since this request consumes the first token
      bucket = { tokens: rpm - 1, lastRefill: now };
      this.buckets.set(key, bucket);
      return true;
    }

    // Refresh LRU order
    this.buckets.delete(key);
    this.buckets.set(key, bucket);

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
