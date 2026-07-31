/**
 * Sanitized process environment — Capabilities (spec 008, T206, FR-008/FR-013).
 *
 * Tool workers receive a minimal allowlisted environment. Provider keys,
 * SMTP credentials, server API keys, release credentials, policy paths, and
 * unrelated user environment values are absent. Only explicit safe values
 * (PATH/HOME replacement, etc.) are passed through.
 *
 * This module is pure data — it does not spawn. The native sandbox and
 * worker image builders consume its output.
 */
import * as os from "node:os";
import * as path from "node:path";

/**
 * The canonical path of the Seepient security directory. No executor
 * read/write root may include or overlap with this path (T108a).
 */
export const SECURITY_DIR_CANONICAL: string = path.join(
  os.homedir(),
  ".seepient",
  "security",
);

/**
 * Returns true if `p` is equal to or a descendant of SECURITY_DIR_CANONICAL.
 * Applies to commit targets, read targets, and process cwd values.
 */
export function isSecurityPath(p: string): boolean {
  const normalized = path.normalize(p);
  return (
    normalized === SECURITY_DIR_CANONICAL ||
    normalized.startsWith(SECURITY_DIR_CANONICAL + path.sep)
  );
}

/**
 * Environment variable prefixes that MUST NOT cross the execution boundary.
 * These are ambient control-plane / release / credential values.
 */
export const FORBIDDEN_ENV_PREFIXES: readonly string[] = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GLM_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_BASE_URL",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "SMTP_", // smtpHost, smtpUser, smtpPass, smtpFrom
  "MAIL_",
  "SEEPIENT_SERVER_",
  "SEEPIENT_RELEASE_",
  "SEEPIENT_AUDIT_",
  "SEEPIENT_POLICY_",
  "AWS_",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "DOCKER_",
  "DATABASE_URL",
  "REDIS_URL",
  "PG_PASSWORD",
];

/**
 * Environment variables explicitly allowed through to the worker. These are
 * runtime-safe (no secrets). PATH/HOME are reconstructed by the caller to a
 * known-good value rather than inherited verbatim.
 */
export const ALLOWED_ENV_KEYS: readonly string[] = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "SHELL",
  "TMPDIR",
];

export interface SanitizeOptions {
  /** caller-supplied safe PATH for the worker (not inherited from parent). */
  path?: string;
  /** caller-supplied safe HOME for the worker (e.g., scratch dir). */
  home?: string;
  /** additional explicitly-allowed env values. */
  extra?: Record<string, string>;
}

/**
 * Return a sanitized environment for a tool worker. The parent process env is
 * never passed through wholesale; only `ALLOWED_ENV_KEYS` survive and only
 * when their values contain no secret-shaped content.
 */
export function sanitizeEnvironment(
  parentEnv: NodeJS.ProcessEnv,
  opts: SanitizeOptions = {},
): Record<string, string> {
  const out: Record<string, string> = {};

  // 1. Allowlisted keys from parent — only if non-secret-shaped.
  for (const key of ALLOWED_ENV_KEYS) {
    const value = parentEnv[key];
    if (value !== undefined && !looksSecret(value)) {
      out[key] = value;
    }
  }

  // 2. Reconstructed PATH/HOME (caller controls — never inherited).
  if (opts.path !== undefined) out.PATH = opts.path;
  if (opts.home !== undefined) out.HOME = opts.home;

  // 3. Explicitly-allowed extras.
  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      if (!isForbidden(k) && !looksSecret(v)) {
        out[k] = v;
      }
    }
  }

  return out;
}

/**
 * Is this env key forbidden? Matches any prefix in FORBIDDEN_ENV_PREFIXES,
 * case-insensitively. Prefixes ending in `_` (like `SMTP_`) match keys that
 * start with them; bare names (like `AWS_ACCESS_KEY_ID`) match exactly or
 * with a `_`-suffix.
 */
export function isForbidden(key: string): boolean {
  const upper = key.toUpperCase();
  return FORBIDDEN_ENV_PREFIXES.some((p) => {
    if (upper === p) return true;
    if (p.endsWith("_")) return upper.startsWith(p);
    return upper.startsWith(p + "_");
  });
}

/**
 * Heuristic: does this value look like a secret? Catches accidental leakage
 * where a secret was placed in an allowlisted var.
 */
export function looksSecret(value: string): boolean {
  // Long, high-entropy base64/hex/token-shaped values.
  if (value.length >= 32 && /^[A-Za-z0-9_\-+/=]+$/.test(value)) {
    // Count distinct characters — a real sentence has low cardinality; a key
    // has high cardinality relative to its length.
    const distinct = new Set(value).size;
    if (distinct >= 20) return true;
  }
  // Common credential markers.
  const lower = value.toLowerCase();
  if (
    lower.startsWith("bearer ") ||
    lower.startsWith("akia") || // AWS key prefix
    lower.startsWith("ghp_") || // GitHub PAT
    lower.startsWith("sk-") // OpenAI key prefix
  ) {
    return true;
  }
  return false;
}
