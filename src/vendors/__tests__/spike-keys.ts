/**
 * Shared key-gating helpers for the S0 spike tests (spec 010, S0.7–S0.15).
 *
 * The spike makes REAL network calls against live providers. Every such call is
 * gated on its env key and SKIPS with a clear message when the key is absent, so
 * the suite stays green in CI / without keys. The operator runs the harness with
 * real keys exported to fill `contracts/inference-adapter.md §6` matrix cells
 * and to record discovery response shapes / rate-limit behavior.
 */
import type { TestContext } from "vitest";

export type EnvGetter = (name: string) => string | undefined;

/** Default env reader (process.env). Overridable in tests via injection. */
export const envProvider: { get: EnvGetter } = {
  get: (name) => process.env[name],
};

/** Returns the env value for `name`, or "" when unset. */
export function env(name: string): string {
  return envProvider.get(name) ?? "";
}

const LIVE_SPIKES_ENV = "RUN_LIVE_SPIKES";

/**
 * Skips the current test when RUN_LIVE_SPIKES is not 1 or `key` is empty. Call at
 * the top of any test body that would make a real network call.
 */
export function requireKey(ctx: TestContext, keyName: string, key: string, hint = ""): void {
  if (process.env[LIVE_SPIKES_ENV] !== "1") {
    ctx.skip(`live spike: set ${LIVE_SPIKES_ENV}=1 to run`);
    return;
  }
  if (!key) {
    const trailer = hint ? ` — ${hint}` : "";
    ctx.skip(`live spike: set ${keyName} to run${trailer}`);
  }
}

/**
 * Env keys the spike recognizes. The single authoritative list of credentials
 * the S0 spike may consume.
 */
export const SPIKE_KEYS = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  glm: "GLM_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_API_KEY",
  ollamaBaseUrl: "OLLAMA_BASE_URL", // OpenAI-compatible; no key by default
  openaiCompatKey: "OPENAI_COMPAT_API_KEY",
  openaiCompatBaseUrl: "OPENAI_COMPAT_BASE_URL",
} as const;
