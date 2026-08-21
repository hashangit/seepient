import { isSensitiveHeader } from "./headers.js";

const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /api[-_]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /auth/i,
  /authorization/i,
  /private[-_]?key/i,
  /credential/i,
  /^refresh$/i,
  /^access$/i,
  /refresh[-_]?token/i,
  /access[-_]?token/i,
];

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /(?:sk-[a-zA-Z0-9_-]{20,})/g, // OpenAI API keys
  /(?:gsk_[a-zA-Z0-9_-]{20,})/g, // Groq / GLM API keys
  /\b(?:gh[pours]_[a-zA-Z0-9]{36,255})\b/g, // GitHub tokens (personal, oauth, user, server, refresh)
  /\b(?:xox[baprs]-[a-zA-Z0-9-]{10,})\b/g, // Slack tokens
  /\b(?:AIza[0-9A-Za-z-_]{35})\b/g, // Google API keys
  /Bearer\s+[a-zA-Z0-9._~+/-]+=*/gi, // Bearer tokens
];

/**
 * Strips user credentials (user:password@) from a URL string.
 */
export function redactUrlCredentials(url: string): string {
  if (!url || typeof url !== "string") return url;
  if (!url.includes("://") || !url.includes("@")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
  } catch {
    // Fallback regex
  }
  return url.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s:]+@/g, "$1");
}

/**
 * Checks if an object property key is considered sensitive.
 */
export function isSensitiveKey(key: string): boolean {
  const lk = key.toLowerCase();
  if (lk === "tokens" || lk.endsWith("tokens") || lk.endsWith("_tokens") || lk.endsWith("-tokens")) {
    return false;
  }
  return isSensitiveHeader(key) || SENSITIVE_KEY_PATTERNS.some((pat) => pat.test(key));
}

/**
 * Redacts known secret tokens from a raw string.
 */
export function redactString(str: string): string {
  let result = redactUrlCredentials(str);
  result = result.replace(
    /((?:["']?(?:access_token|refresh_token|refresh|access|api_key|apiKey|password)["']?\s*[:=]\s*["']?))[a-zA-Z0-9._~+/-]+(["']?)/gi,
    "$1[REDACTED]$2",
  );
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

/**
 * Universal deep redaction for objects, arrays, errors, and primitives.
 */
export function redact<T>(value: T, seen = new WeakSet()): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactString(value) as unknown as T;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "symbol") {
    return value;
  }

  if (value instanceof Error) {
    const errorCopy = Object.create(Object.getPrototypeOf(value));
    errorCopy.message = redactString(value.message);
    if (value.stack) errorCopy.stack = redactString(value.stack);
    if ((value as any).cause) errorCopy.cause = redact((value as any).cause, seen);
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key !== "message" && key !== "stack" && key !== "cause") {
        if (isSensitiveKey(key) && typeof (value as any)[key] !== "object") {
          errorCopy[key] = "[REDACTED]";
        } else {
          errorCopy[key] = redact((value as any)[key], seen);
        }
      }
    }
    return errorCopy;
  }

  if (typeof value === "object") {
    if (seen.has(value as any)) {
      return "[CIRCULAR]" as unknown as T;
    }
    seen.add(value as any);

    if (Array.isArray(value)) {
      return value.map((item) => redact(item, seen)) as unknown as T;
    }

    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      if (isSensitiveKey(k)) {
        if (v === null || v === undefined) {
          result[k] = v;
        } else if (typeof v === "string") {
          result[k] = "[REDACTED]";
        } else if (Array.isArray(v)) {
          result[k] = v.map((item) => (typeof item === "string" ? "[REDACTED]" : redact(item, seen)));
        } else if (typeof v === "object") {
          // If it's a specific credential object descriptor (with kind/ref/keyValue/value)
          if ("kind" in v || "ref" in v || "keyValue" in v || "value" in v || k.toLowerCase() === "credential") {
            result[k] = {
              kind: (v as any).kind ?? (v as any).ref?.kind ?? "redacted",
              id: "[REDACTED]",
            };
          } else {
            result[k] = redact(v, seen);
          }
        } else {
          result[k] = "[REDACTED]";
        }
      } else {
        result[k] = redact(v, seen);
      }
    }
    return result as unknown as T;
  }

  return value;
}

