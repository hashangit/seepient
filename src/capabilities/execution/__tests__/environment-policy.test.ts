/**
 * P2 environment sanitization tests (spec 008, T206, QS-2.5).
 *
 * Verifies provider/SMTP/server/release/policy secrets are absent from the
 * sanitized env, and safe values (PATH/HOME replacement) match the allowlist.
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeEnvironment,
  isForbidden,
  looksSecret,
  FORBIDDEN_ENV_PREFIXES,
  ALLOWED_ENV_KEYS,
} from "../environment-policy.js";

describe("environment sanitization (T206, QS-2.5)", () => {
  const parentEnv: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: "sk-deadbeef",
    ANTHROPIC_API_KEY: "sk-ant-deadbeef",
    GLM_API_KEY: "glm-key",
    SMTP_USER: "mailer",
    SMTP_PASS: "pass",
    SEEPIENT_SERVER_API_KEY: "srv-key",
    SEEPIENT_RELEASE_KEY: "rel-key",
    AWS_ACCESS_KEY_ID: "AKIAFAKE",
    GITHUB_TOKEN: "ghp_fake",
    DATABASE_URL: "postgres://user:pass@host/db",
    LANG: "en_US.UTF-8",
    TZ: "UTC",
    TERM: "xterm-256color",
    HOME: "/real/home",
    PATH: "/usr/bin",
  };

  it("strips all ambient credential vars", () => {
    const env = sanitizeEnvironment(parentEnv, { path: "/safe/path", home: "/scratch" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GLM_API_KEY).toBeUndefined();
    expect(env.SMTP_USER).toBeUndefined();
    expect(env.SMTP_PASS).toBeUndefined();
    expect(env.SEEPIENT_SERVER_API_KEY).toBeUndefined();
    expect(env.SEEPIENT_RELEASE_KEY).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("passes allowlisted safe values", () => {
    const env = sanitizeEnvironment(parentEnv, { path: "/safe/path", home: "/scratch" });
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TZ).toBe("UTC");
    expect(env.TERM).toBe("xterm-256color");
  });

  it("replaces PATH and HOME with caller-supplied safe values, not inherited", () => {
    const env = sanitizeEnvironment(parentEnv, { path: "/safe/path", home: "/scratch" });
    expect(env.PATH).toBe("/safe/path");
    expect(env.HOME).toBe("/scratch");
    expect(env.PATH).not.toBe("/usr/bin");
  });

  it("catches secrets hidden in allowlisted vars", () => {
    const env = sanitizeEnvironment(
      { ...parentEnv, TZ: "sk-deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      {},
    );
    // Secret-shaped value in an allowlisted var is stripped.
    expect(env.TZ).toBeUndefined();
  });
});

describe("isForbidden", () => {
  it("matches exact and prefixed forbidden keys", () => {
    expect(isForbidden("OPENAI_API_KEY")).toBe(true);
    expect(isForbidden("SMTP_HOST")).toBe(true);
    expect(isForbidden("SEEPIENT_SERVER_TOKEN")).toBe(true);
    expect(isForbidden("LANG")).toBe(false);
    expect(isForbidden("MY_APP_CONFIG")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isForbidden("openai_api_key")).toBe(true);
  });
});

describe("looksSecret", () => {
  it("detects long high-entropy values", () => {
    expect(looksSecret("sk-abcd1234abcd1234abcd1234abcd1234abcd1234")).toBe(true);
    expect(looksSecret("AKIA1234567890ABCDEF")).toBe(true);
  });

  it("passes short human-readable values", () => {
    expect(looksSecret("UTC")).toBe(false);
    expect(looksSecret("xterm-256color")).toBe(false);
    expect(looksSecret("en_US.UTF-8")).toBe(false);
  });

  it("detects known credential prefixes", () => {
    expect(looksSecret("Bearer abc")).toBe(true);
    expect(looksSecret("ghp_1234567890")).toBe(true);
    expect(looksSecret("sk-live-key")).toBe(true);
  });
});

describe("constant surface", () => {
  it("FORBIDDEN_ENV_PREFIXES includes provider/server/release/policy", () => {
    expect(FORBIDDEN_ENV_PREFIXES).toContain("OPENAI_API_KEY");
    expect(FORBIDDEN_ENV_PREFIXES).toContain("ANTHROPIC_API_KEY");
    expect(FORBIDDEN_ENV_PREFIXES).toContain("SEEPIENT_SERVER_");
    expect(FORBIDDEN_ENV_PREFIXES).toContain("SEEPIENT_RELEASE_");
    expect(FORBIDDEN_ENV_PREFIXES).toContain("SEEPIENT_POLICY_");
    expect(FORBIDDEN_ENV_PREFIXES).toContain("SEEPIENT_AUDIT_");
  });

  it("ALLOWED_ENV_KEYS excludes secret-bearing names", () => {
    expect(ALLOWED_ENV_KEYS).not.toContain("OPENAI_API_KEY");
    expect(ALLOWED_ENV_KEYS).toContain("LANG");
    // PATH/HOME are intentionally NOT in the allowlist — they are
    // reconstructed by the caller to a known-safe value, never inherited.
    expect(ALLOWED_ENV_KEYS).not.toContain("PATH");
    expect(ALLOWED_ENV_KEYS).not.toContain("HOME");
  });
});
