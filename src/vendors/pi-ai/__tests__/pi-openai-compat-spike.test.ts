/**
 * S0 spike — OpenAI-compatible endpoint, Ollama (spec 010, S0.14).
 *
 * Ollama exposes an OpenAI-compatible `/v1/chat/completions` API and is
 * keyless (local server). Pi's OpenAI provider resolves its base URL + key from
 * the ambient env (`OPENAI_BASE_URL` / `OPENAI_API_KEY`); the spike points that
 * at an operator-supplied Ollama URL via `OLLAMA_BASE_URL`. If neither
 * `OLLAMA_BASE_URL` nor a real `OPENAI_COMPAT_BASE_URL` is set, the test skips.
 */
import { describe, it, expect } from "vitest";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Models, Model, Api, UserMessage } from "@earendil-works/pi-ai";
import { env, requireKey, SPIKE_KEYS } from "../../__tests__/spike-keys.js";

/** Build a Pi user message (timestamp is required by Pi's UserMessage type). */
function user(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

/**
 * Build a Models collection and, if an OpenAI-compatible base URL is provided,
 * monkeypatch the OpenAI provider's `baseUrl` so the stream targets it. Pi's
 * provider factory reads base URL at construction from env; the spike overrides
 * the resolved provider instance directly to keep the test self-contained.
 */
function openAiCompatModels(baseUrl: string): Models {
  const m = builtinModels();
  // Pi exposes providers as mutable on the `MutableModels` collection; the
  // OpenAI provider instance is fetched and its baseUrl overridden.
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
    // Ollama is keyless; supply a dummy key so Pi's ambient auth resolves.
    if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = "ollama-no-key-needed";

    const m = openAiCompatModels(baseUrl);
    const ids = m.getModels("openai").map((x) => x.id);
    const modelId = ids[0] ?? "gpt-4.1-mini";
    const model = m.getModel("openai", modelId) as Model<Api>;
    const stream = m.stream(model, { messages: [user("Reply with the single word OK.")] });
    const events: { type: string }[] = [];
    for await (const ev of stream) {
      events.push(ev);
      if (ev.type === "done" || ev.type === "error") break;
    }
    const terminal = events.find((e) => e.type === "done" || e.type === "error");
    expect(terminal, "stream must terminate").toBeDefined();
    expect(events.some((e) => e.type === "text_delta"), "expected at least one text_delta").toBe(true);
  }, 30_000);
});
