/**
 * Security header deny-list patterns for redacting sensitive headers from
 * diagnostic logs, error reports, and traces (Contract: credential-store.md §5).
 */
const SENSITIVE_HEADER_PATTERNS: readonly RegExp[] = [
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^proxy-authorization$/i,
  /^x-seepient-/i,
  /^x-api-key$/i,
  /^x-auth-token$/i,
  /^x-.*-key$/i,
  /^x-.*-token$/i,
  /^x-goog-api-key$/i,
];

/**
 * Checks if a given header name is considered sensitive and must be redacted.
 */
export function isSensitiveHeader(headerName: string): boolean {
  return SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(headerName));
}

/**
 * Redacts sensitive headers from a headers record, replacing sensitive values with `[REDACTED]`.
 */
export function sanitizeHeaders(
  headers: Record<string, string | null | undefined>,
): Record<string, string | null | undefined> {
  const result: Record<string, string | null | undefined> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (val === null || val === undefined) {
      result[key] = val;
    } else if (isSensitiveHeader(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = val;
    }
  }
  return result;
}
