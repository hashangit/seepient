/**
 * S0 spike — Pi language streaming across OpenAI / Anthropic / GLM (spec 010,
 * S0.7–S0.11 + S0.13).
 *
 * Verifies Pi's `builtinModels().stream(model, context)` works end-to-end for:
 *   - tool calls (S0.7)
 *   - streaming deltas (S0.8)
 *   - reasoning + signature preservation (S0.9, Anthropic)
 *   - usage accounting (S0.10)
 *   - clean abort (S0.11)
 *
 * Every test makes a REAL network call and is gated on its provider env key.
 * Without the key the test SKIPS with a clear message; the suite stays green in
 * CI. Operator runs with keys exported to record the S0 evidence. Results get
 * pasted into research.md §"Probe results".
 *
 * Positive-path tests require a `done` terminal event (an `error` event fails
 * the probe) so a provider regression surfaces instead of being masked.
 */
import { describe, it, expect } from "vitest";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Models, Model, Api, UserMessage, Tool, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { env, requireKey, SPIKE_KEYS } from "../../__tests__/spike-keys.js";

/** Build a Models collection with all builtin providers + env-based auth. */
function models(): Models {
  return builtinModels();
}

/** Build a Pi user message (timestamp is required by Pi's UserMessage type). */
function user(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

/** Resolve a concrete model id from a provider's catalog, or "" if unknown. */
function pickModel(m: Models, provider: string, preferredId: string): string {
  const ids = m.getModels(provider).map((x) => x.id);
  return ids.includes(preferredId) ? preferredId : (ids[0] ?? "");
}

/** Collect all events from a stream into an array (terminal `done`/`error` ends it). */
async function collect(iter: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const out: AssistantMessageEvent[] = [];
  for await (const ev of iter) {
    out.push(ev);
    if (ev.type === "done" || ev.type === "error") break;
  }
  return out;
}

/** Require a successful `done` terminal event; throw a clear message on `error`. */
function requireDone(events: AssistantMessageEvent[]): Extract<AssistantMessageEvent, { type: "done" }> {
  const done = events.find((e): e is Extract<AssistantMessageEvent, { type: "done" }> => e.type === "done");
  const err = events.find((e): e is Extract<AssistantMessageEvent, { type: "error" }> => e.type === "error");
  if (!done) {
    const detail = err ? ` (error reason: ${err.reason})` : " (no terminal event)";
    throw new Error(`expected a successful 'done' terminal event${detail}`);
  }
  return done;
}

describe("S0.7–S0.11 Pi language spike", () => {
  it("OpenAI: streams a text turn with usage (S0.8 + S0.10)", async (ctx) => {
    const key = env(SPIKE_KEYS.openai);
    requireKey(ctx, SPIKE_KEYS.openai, key, "to run the live OpenAI stream");
    const m = models();
    const model = m.getModel("openai", pickModel(m, "openai", "gpt-4.1-mini")) as Model<Api>;
    const events = await collect(m.stream(model, { messages: [user("Reply with the single word PONG.")] }));
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.length, "expected at least one text_delta").toBeGreaterThan(0);
    const done = requireDone(events);
    expect(done.message, "done carries the final AssistantMessage").toBeDefined();
  }, 30_000);

  it("Anthropic: preserves reasoning + signature (S0.9)", async (ctx) => {
    const key = env(SPIKE_KEYS.anthropic);
    requireKey(ctx, SPIKE_KEYS.anthropic, key, "to run the live Anthropic reasoning stream");
    const m = models();
    const model = m.getModel("anthropic", pickModel(m, "anthropic", "claude-haiku-4-5")) as Model<Api>;
    // streamSimple takes SimpleStreamOptions which carries `reasoning: ThinkingLevel`.
    const events = await collect(
      m.streamSimple(model, { messages: [user("Think briefly about 17*23, then say READY.")] }, { reasoning: "low" }),
    );
    requireDone(events);
    // Reasoning-capable model with reasoning on MUST emit thinking_delta events.
    const thinking = events.filter((e) => e.type === "thinking_delta");
    expect(thinking.length, "expected thinking_delta events when reasoning is enabled").toBeGreaterThan(0);
    // A thinking content block carries an opaque signature for multi-turn continuity.
    const thinkingEnd = events.find((e) => e.type === "thinking_end") as Extract<AssistantMessageEvent, { type: "thinking_end" }> | undefined;
    expect(thinkingEnd, "expected a thinking_end event").toBeDefined();
    // Record presence of the signature-bearing content (provenance triple asserted at P3.2).
    expect(typeof thinkingEnd!.content, "thinking_end carries content").toBe("string");
  }, 60_000);

  it("GLM (zai): streams a turn (S0.13)", async (ctx) => {
    const key = env(SPIKE_KEYS.glm);
    requireKey(ctx, SPIKE_KEYS.glm, key, "to run the live GLM stream");
    const m = models();
    const model = m.getModel("zai", pickModel(m, "zai", "glm-4.5-air")) as Model<Api>;
    const events = await collect(m.stream(model, { messages: [user("Reply with the single word GLM.")] }));
    expect(events.some((e) => e.type === "text_delta"), "expected at least one text_delta").toBe(true);
    requireDone(events);
  }, 30_000);

  it("OpenAI: tool-call round-trip (S0.7)", async (ctx) => {
    const key = env(SPIKE_KEYS.openai);
    requireKey(ctx, SPIKE_KEYS.openai, key, "to run the live OpenAI tool-call stream");
    const m = models();
    const model = m.getModel("openai", pickModel(m, "openai", "gpt-4.1-mini")) as Model<Api>;
    const events = await collect(m.stream(model, {
      messages: [user("What is the weather in Tokyo? Use the get_weather tool.")],
      tools: [{
        name: "get_weather",
        description: "Get current weather for a city",
        parameters: Type.Object({ city: Type.String() }),
      } satisfies Tool],
    }));
    const done = requireDone(events);
    expect(done.reason).toBe("toolUse");
    const toolcallEnd = events.find((e) => e.type === "toolcall_end");
    expect(toolcallEnd, "expected a toolcall_end event for a toolUse stop").toBeDefined();
  }, 30_000);

  it("AbortController aborts the stream cleanly (S0.11)", async (ctx) => {
    const key = env(SPIKE_KEYS.openai) || env(SPIKE_KEYS.anthropic);
    const provider = env(SPIKE_KEYS.openai) ? "openai" : "anthropic";
    const keyName = env(SPIKE_KEYS.openai) ? SPIKE_KEYS.openai : SPIKE_KEYS.anthropic;
    requireKey(ctx, keyName, key, "to run the live abort spike");
    const m = models();
    const model = m.getModel(provider, pickModel(m, provider, provider === "openai" ? "gpt-4.1-mini" : "claude-haiku-4-5")) as Model<Api>;
    const ac = new AbortController();
    const events: AssistantMessageEvent[] = [];
    let aborted = false;
    try {
      for await (const ev of m.stream(
        model,
        { messages: [user("Count slowly from 1 to 100, one per line.")] },
        { signal: ac.signal },
      )) {
        events.push(ev);
        if (ev.type === "text_delta" && !aborted) {
          aborted = true;
          ac.abort();
        }
        if (ev.type === "done" || ev.type === "error") break;
      }
    } catch (err) {
      // Abort may surface as a thrown AbortError — acceptable for the clean-abort contract.
      expect(aborted, "abort was requested before throwing").toBe(true);
      expect(String(err), "abort error should reference abort").toMatch(/abort/i);
      return;
    }
    // If no throw, the stream must have terminated with an `error` (aborted) event.
    expect(aborted, "abort was requested").toBe(true);
    const err = events.find((e): e is Extract<AssistantMessageEvent, { type: "error" }> => e.type === "error");
    expect(err, "expected an error terminal event after abort").toBeDefined();
    expect(err!.reason, "error reason is aborted").toBe("aborted");
  }, 30_000);
});
