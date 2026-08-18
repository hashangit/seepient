import type { InferenceErrorCode } from "../errors.js";

export interface ClassifiedError {
  code: InferenceErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
}

/**
 * Unified error classifier for all inference adapters, vendors, and transport protocols.
 * Normalizes HTTP status codes, network faults, rate limits, timeouts, and SDK errors.
 */
export function classifyInferenceError(
  errorOrMessage: unknown,
  isTimeout = false,
  status?: number,
): ClassifiedError {
  if (isTimeout) {
    return { code: "timeout", retryable: true };
  }

  // 1. HTTP Status Code Mapping
  if (typeof status === "number") {
    if (status === 429) return { code: "rate_limit", retryable: true };
    if (status === 401 || status === 403) return { code: "auth", retryable: false };
    if (status === 404) return { code: "unknown_model", retryable: false };
    if (status === 408 || status === 504) return { code: "timeout", retryable: true };
    if (status === 500 || status === 502 || status === 503) {
      return { code: "provider_unavailable", retryable: true };
    }
    if (status === 400) return { code: "invalid_request", retryable: false };
  }

  const msg =
    typeof errorOrMessage === "string"
      ? errorOrMessage
      : (errorOrMessage as any)?.message || String(errorOrMessage || "");
  const lower = msg.toLowerCase();

  // 2. Rate Limits & Quotas
  if (
    lower.includes("rate limit") ||
    /\b429\b/.test(lower) ||
    lower.includes("quota exceeded") ||
    lower.includes("resource_exhausted") ||
    lower.includes("too many requests")
  ) {
    // Attempt parsing Retry-After header/message hint if present
    const retryMatch = msg.match(/retry[- ]after[: ]+(\d+)/i) || msg.match(/try again in (\d+)/i);
    const retryAfterMs = retryMatch ? parseInt(retryMatch[1], 10) * 1000 : undefined;
    return { code: "rate_limit", retryable: true, retryAfterMs };
  }

  // 3. Authentication & Credentials
  if (
    lower.includes("unauthorized") ||
    lower.includes("api key") ||
    lower.includes("invalid key") ||
    lower.includes("permission_denied") ||
    /\b401\b/.test(lower) ||
    /\b403\b/.test(lower) ||
    /\bauth\b/.test(lower) ||
    lower.includes("authentication")
  ) {
    return { code: "auth", retryable: false };
  }

  // 4. Overload & Capacity
  if (
    lower.includes("overloaded") ||
    lower.includes("capacity") ||
    lower.includes("service unavailable") ||
    /\b503\b/.test(lower) ||
    /\b502\b/.test(lower) ||
    /\b500\b/.test(lower)
  ) {
    return { code: "overload", retryable: true };
  }

  // 5. Context Overflow
  if (
    lower.includes("context length") ||
    lower.includes("context window") ||
    lower.includes("context exceeded") ||
    lower.includes("maximum context") ||
    lower.includes("prompt is too long") ||
    lower.includes("max_tokens") ||
    lower.includes("token limit") ||
    lower.includes("context_length_exceeded")
  ) {
    return { code: "context_overflow", retryable: false };
  }

  // 6. Network & Transport Disconnections
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("socket hang up") ||
    lower.includes("connection reset") ||
    lower.includes("hang up")
  ) {
    return { code: "network", retryable: true };
  }

  // 7. Unknown Models
  if (
    lower.includes("model not found") ||
    lower.includes("does not exist") ||
    lower.includes("unknown model") ||
    /\b404\b/.test(lower)
  ) {
    return { code: "unknown_model", retryable: false };
  }

  // 8. Content / Safety Policy
  if (
    lower.includes("safety") ||
    lower.includes("content policy") ||
    lower.includes("moderation") ||
    lower.includes("blocked")
  ) {
    return { code: "content_policy", retryable: false };
  }

  return { code: "internal_adapter", retryable: false };
}
