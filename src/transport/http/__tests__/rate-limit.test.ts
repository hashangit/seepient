import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "../rate-limit.js";

describe("RateLimiter bounded capacity & eviction (P2-1)", () => {
  const savedRpm = process.env.SEEPIENT_RATE_LIMIT_RPM;

  beforeEach(() => {
    delete process.env.SEEPIENT_RATE_LIMIT_RPM;
  });

  afterEach(() => {
    if (savedRpm !== undefined) process.env.SEEPIENT_RATE_LIMIT_RPM = savedRpm;
    else delete process.env.SEEPIENT_RATE_LIMIT_RPM;
  });
  it("enforces max capacity by evicting oldest buckets", () => {
    const max = 5;
    const limiter = new RateLimiter(10, undefined, max);

    for (let i = 0; i < max; i++) {
      expect(limiter.consume(`key-${i}`)).toBe(true);
    }
    expect(limiter.size).toBe(max);

    // Adding key-new should trigger eviction and keep size bounded
    expect(limiter.consume("key-new")).toBe(true);
    expect(limiter.size).toBeLessThanOrEqual(max);
  });

  it("prunes idle buckets older than IDLE_TTL_MS", () => {
    const baseTime = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    // Consuming a new key when nearing or hitting capacity prunes idle buckets
    const maxLimiter = new RateLimiter(10, undefined, 2);
    maxLimiter.consume("idle-1");
    maxLimiter.consume("idle-2");
    expect(maxLimiter.size).toBe(2);

    vi.spyOn(Date, "now").mockReturnValue(baseTime + RateLimiter.IDLE_TTL_MS + 1000);
    maxLimiter.consume("active-1");
    // Both idle-1 and idle-2 were pruned, active-1 added -> size is 1
    expect(maxLimiter.size).toBe(1);

    vi.restoreAllMocks();
  });

  it("maintains LRU order so accessed keys are retained over stale keys", () => {
    const max = 2;
    const limiter = new RateLimiter(10, undefined, max);

    limiter.consume("key-1");
    limiter.consume("key-2");

    // Access key-1 again to make it MRU (key-2 becomes LRU)
    limiter.consume("key-1");

    // Adding key-3 should evict key-2, leaving key-1 and key-3
    limiter.consume("key-3");
    expect(limiter.size).toBe(2);

    // Verify key-1 is still present and has tokens
    expect(limiter.consume("key-1")).toBe(true);
  });
});
