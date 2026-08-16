/**
 * S0 spike — OpenAI-compatible endpoint, Ollama (spec 010, S0.14).
 *
 * Ollama exposes an OpenAI-compatible `/v1/chat/completions` API and is
 * keyless (local server). Pi's OpenAI provider resolves its base URL + key from
 * the ambient env (`OPENAI_BASE_URL` / `OPENAI_API_KEY`); the spike points that
 * at an operator-supplied Ollama URL via `OLLAMA_BASE_URL` and an
 * operator-supplied model id via `OLLAMA_MODEL`. If neither `OLLAMA_BASE_URL`
 * nor a real `OPENAI_COMPAT_BASE_URL` is set, the test skips.
 *
 * Positive-path requires a `done` terminal event. The model id comes from the
 * operator (Ollama serves whatever the operator pulled), NOT from Pi's static
 * OpenAI catalog.
 */
import { describe, it, expect, afterEach } from "vitest";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Models, Model, Api, UserMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { env, requireKey, SPIKE_KEYS } from "../../__tests__/spike-keys.js";

/** Build a Pi user message (timestamp is required by Pi's UserMessage type). */
function user(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

/** Saved env state for OPENAI_API_KEY / OPENAI_BASE_URL, restored after the test. */
const envSnapshots: { key?: string; baseUrl?: string } = {};
afterEach(() => {
  if (envSnapshots.key === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = envSnapshots.key;
  if (envSnapshots.baseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = envSnapshots.baseUrl;
});

/**
 * Build a Models collection and override the OpenAI provider's `baseUrl` so the
 * stream targets the OpenAI-compatible endpoint. Pi's provider factory reads
 * base URL at construction from env; the spike overrides the resolved provider
 * instance directly to keep the test self-contained.
 */
function openAiCompatModels(baseUrl: string): Models {
  const m = builtinModels();
  const provider = m.getProvider("openai");
  if (provider) {
    (provider as { baseUrl?: string }).baseUrl = baseUrl;
  }
  return m;
}

describe("S0.14 OpenAI-compatible (Ollama) spike", () => {
  it("streams a turn from an OpenAI-compatible endpoint", async (ctx) => {
    const baseUrl = env(SPIKE_KEYS.ollamaBaseUrl) || env(SPIKE_KEYS.openaiCompatBaseUrl);
    requireKey(
      ctx,
      `${SPIKE_KEYS.ollamaBaseUrl} or ${SPIKE_KEYS.openaiCompatBaseUrl}`,
      baseUrl,
      "to run the live OpenAI-compatible (Ollama) stream",
    );
    // Operator-supplied model id (whatever they pulled in Ollama) — NOT a static
    // OpenAI catalog id, which would not exist on the Ollama server.
    const modelId = env("OLLAMA_MODEL") || "llama3.2";

    // Snapshot + mutate env: Ollama is keyless, so supply a dummy key so Pi's
    // ambient auth resolves. For authenticated compat endpoints, use compatKey.
    const compatKey = env(SPIKE_KEYS.openaiCompatKey);
    envSnapshots.key = process.env.OPENAI_API_KEY;
    envSnapshots.baseUrl = process.env.OPENAI_BASE_URL;
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = compatKey || "ollama-no-key-needed";
    }

    const m = openAiCompatModels(baseUrl);
    // getModel() requires the id to exist in Pi's catalog; Ollama models do not.
    // Construct a minimal Model descriptor bound to the overridden provider so
    // stream() targets the OpenAI-completions API at the Ollama base URL.
    const anyModel = { id: modelId, api: "openai-completions" } as unknown as Model<Api>;
    const events: AssistantMessageEvent[] = [];
    for await (const ev of m.stream(anyModel, { messages: [user("Reply with the single word OK.")] })) {
      events.push(ev);
      if (ev.type === "done" || ev.type === "error") break;
    }
    expect(events.some((e) => e.type === "text_delta"), "expected at least one text_delta").toBe(true);
    const done = events.find((e) => e.type === "done");
    const err = events.find((e) => e.type === "error") as Extract<AssistantMessageEvent, { type: "error" }> | undefined;
    expect(done, `expected a successful 'done' terminal event${err ? ` (got error: ${err.reason})` : ""}`).toBeDefined();
  }, 30_000);
});
