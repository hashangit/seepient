import { describe, it, expect } from "vitest";
import {
  computeBackoffDelay,
  abortableSleep,
} from "../provider-runtime.js";
import type { RetryPolicy } from "../../../foundations/schemas/provider-config.js";

describe("B-5: Retry Delay Bounds & Abort Reliability", () => {
  const policy: RetryPolicy = {
    maxAttempts: 3,
    operationTimeoutMs: 60_000,
    streamingIdleTimeoutMs: 30_000,
    backoffBaseMs: 500,
    backoffMultiplier: 2,
    backoffJitter: 0.25,
    backoffCapMs: 5000,
    cooldownThreshold: 3,
    cooldownDurationMs: 60_000,
  };

  it("computes delay within exact jitter and exponential bounds", () => {
    // Attempt 0: base 500, 2^0 = 1 -> range [375, 625]
    for (let i = 0; i < 20; i++) {
      const delay0 = computeBackoffDelay(0, policy);
      expect(delay0).toBeGreaterThanOrEqual(375);
      expect(delay0).toBeLessThanOrEqual(625);
    }

    // Attempt 1: base 500 * 2 = 1000 -> range [750, 1250]
    for (let i = 0; i < 20; i++) {
      const delay1 = computeBackoffDelay(1, policy);
      expect(delay1).toBeGreaterThanOrEqual(750);
      expect(delay1).toBeLessThanOrEqual(1250);
    }
  });

  it("clamps retry delay to backoffCapMs", () => {
    // Attempt 10: 500 * 2^10 = 512,000 -> clamped to 5000 with jitter [3750, 5000]
    for (let i = 0; i < 20; i++) {
      const delayHigh = computeBackoffDelay(10, policy);
      expect(delayHigh).toBeLessThanOrEqual(5000);
      expect(delayHigh).toBeGreaterThanOrEqual(3750);
    }
  });

  it("abortableSleep aborts immediately when signal is triggered", async () => {
    const ac = new AbortController();
    const start = Date.now();

    setTimeout(() => ac.abort(new Error("user canceled")), 20);

    await expect(abortableSleep(5000, ac.signal)).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // Exits immediately without waiting 5000ms
  });
});
