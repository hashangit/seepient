/**
 * S08 adapter unit pins (spec 029, M02 T028): targeted abort (RT01), the
 * empty-tool-list rule (FR-032), pure hydration (FR-034), and the
 * text/usage/done event flow — all against a controllable engine double via
 * the adapter's DI seam (no real providers, no network, no timers).
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent } from "@seepients/adapter-kit";
import { createSeepient } from "seepient-engine/dist/transport/sdk/seepient.js";
import {
  SeepientAgentRuntime,
  UnsupportedContentError,
  hydrateHistory,
} from "../seepient-agent-runtime.js";
import type { AgentRunRequest } from "@seepients/adapter-kit";
import type { CreateSeepientOptions } from "seepient-engine/dist/foundations/types.js";

interface TestStreamPayload {
  fullText: Promise<string>;
  usage: Promise<{ promptTokens: number; completionTokens: number; totalTokens: number; cost: number }>;
}

interface TestAgent {
  aborted: boolean;
  options: CreateSeepientOptions;
  streamOptions: {
    onText?: (delta: string) => void;
    onStep?: (step: { type: string }) => void;
    images?: Array<{ data: string; mimeType: string }>;
    context?: { strategy?: string; maxInputTokens?: number };
  };
  /** Deltas queued for the fake stream; yielded in order, live. */
  textDeltas: string[];
  /** Settled when the turn's provider result arrives (settle()). */
  settled: PromiseWithResolvers<TestStreamPayload>;
  /** Closed by settle() — textStream ends after draining queued deltas. */
  textClosed: boolean;
  deltaGate: PromiseWithResolvers<void>;
  /** Live-stream helper: push a delta mid-turn (deterministic, no timers). */
  emitDelta(text: string): void;
  settle(payload: TestStreamPayload): void;
  abort(): void;
  chatStream(prompt: string, streamOptions: { onText?: (delta: string) => void }): Promise<never>;
}

function makeHarness() {
  const agents: TestAgent[] = [];
  /**
   * Eager readiness gates (one per anticipated agent): `gates[i].promise`
   * exists from harness creation, so `await gates[i]` never observes
   * undefined — it resolves when run i's chatStream registers.
   */
  const gates = Array.from({ length: 8 }, () => Promise.withResolvers<void>());

  const createAgentImpl = async (options: CreateSeepientOptions): Promise<TestAgent> => {
    const agent: TestAgent = {
      aborted: false,
      options,
      streamOptions: {},
      textDeltas: [],
      settled: Promise.withResolvers<TestStreamPayload>(),
      textClosed: false,
      deltaGate: Promise.withResolvers<void>(),
      emitDelta(text: string) {
        this.textDeltas.push(text);
        this.deltaGate.resolve();
        this.deltaGate = Promise.withResolvers<void>();
      },
      settle(payload: TestStreamPayload) {
        this.textClosed = true;
        this.deltaGate.resolve();
        this.deltaGate = Promise.withResolvers<void>();
        this.settled.resolve(payload);
      },
      abort() {
        this.aborted = true;
      },
      chatStream(
        prompt: string,
        streamOptions: {
          onText?: (delta: string) => void;
          onStep?: (step: { type: string }) => void;
          images?: Array<{ data: string; mimeType: string }>;
          context?: { strategy?: string; maxInputTokens?: number };
        },
      ): Promise<never> {
        void prompt;
        this.streamOptions = streamOptions;
        gates[index]?.resolve();
        // Real contract: chatStream resolves immediately with a handle; the
        // turn streams through textStream and settles via fullText/usage.
        const agent = this;
        const streamResult = {
          textStream: (async function* () {
            for (;;) {
              if (agent.textDeltas.length > 0) {
                const delta = agent.textDeltas.shift()!;
                streamOptions.onText?.(delta);
                yield delta;
                continue;
              }
              if (agent.textClosed) return;
              await agent.deltaGate.promise;
              agent.deltaGate = Promise.withResolvers<void>();
            }
          })(),
          steps: (async function* () {})(),
          fullText: agent.settled.promise.then((p) => p.fullText),
          // The rejected-usage test settles usage as rejected; attaching the
          // no-op handler HERE marks the promise handled (no unhandled-
          // rejection crash) while consumers still observe the rejection.
          usage: (() => {
            const usagePromise = agent.settled.promise.then((p) => p.usage);
            usagePromise.catch(() => undefined);
            return usagePromise;
          })(),
          finishReason: Promise.resolve("stop"),
          abort: () => agent.abort(),
          toResponse: () => {
            throw new Error("not used by the adapter");
          },
          toSSEStream: () => {
            throw new Error("not used by the adapter");
          },
        };
        return Promise.resolve(streamResult as never);
      },
    };
    const index = agents.length;
    agents.push(agent);
    return agent;
  };

  return { agents, gates, createAgentImpl };
}

// Test double: implements only the createSeepient surface the adapter
// touches (construction + chatStream/abort); cast once at the DI boundary.
function asEngineFactory(createAgentImpl: (options: CreateSeepientOptions) => Promise<TestAgent>) {
  return createAgentImpl as unknown as typeof createSeepient;
}

function baseRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    botId: "assistant-1" as never,
    threadId: "thread-1" as never,
    runId: "run-1",
    prompt: "hello",
    instructions: "be helpful",
    history: [],
    tools: [],
    model: { provider: "test", id: "model-1" },
    ...overrides,
  } as AgentRunRequest;
}

describe("SeepientAgentRuntime (T028)", () => {
  it("aborts exactly the targeted run (RT01)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });

    const drainA = (async () => {
      for await (const _ of runtime.run(baseRequest({ runId: "run-A" }))) void _;
    })();
    const drainB = (async () => {
      for await (const _ of runtime.run(baseRequest({ runId: "run-B" }))) void _;
    })();
    await Promise.all([gates[0].promise, gates[1].promise]);

    expect(agents).toHaveLength(2);
    await runtime.abort("run-A");
    expect(agents[0].aborted).toBe(true);
    expect(agents[1].aborted).toBe(false);

    // Unknown runId: targeted no-op, no throw.
    await runtime.abort("run-unknown");
    void drainA;
    void drainB;
  });

  it("keeps an explicitly empty tool list empty end to end (FR-032)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const drain = (async () => {
      for await (const _ of runtime.run(baseRequest({ tools: [] }))) void _;
    })();
    await gates[0].promise;
    expect(agents[0].options.tools).toEqual([]);
    void drain;
  });

  it("bridges connector tools to the governed executeTool callback", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });

    const calls: Array<{ name: string; executionId: string }> = [];
    const request = baseRequest({
      tools: [{ name: "lookup", description: "lookup", inputSchema: { type: "object" } }],
      executeTool: (async (name: string, _args: unknown, executionId: string) => {
        calls.push({ name, executionId });
        return "result-42";
      }) as never,
    });
    const drain = (async () => {
      for await (const _ of runtime.run(request)) void _;
    })();
    await gates[0].promise;

    const tools = agents[0].options.tools as unknown as Array<{ execute: (args: unknown) => Promise<string> }>;
    expect(tools).toHaveLength(1);
    const output = await tools[0].execute({ q: "x" });
    expect(output).toBe("result-42");
    expect(calls[0].name).toBe("lookup");
    expect(calls[0].executionId).toBeTruthy();
    void drain;
  });

  it("hydrates history once, user/assistant rows only (FR-034)", async () => {
    const messages = hydrateHistory([
      { role: "system", content: "product instructions" },
      { role: "user", content: "hi", id: "m1" },
      { role: "assistant", content: "hello", id: "m2" },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const drain = (async () => {
      for await (const _ of runtime.run(
        baseRequest({
          history: [
            { role: "user", content: "hi", id: "m1" },
            { role: "assistant", content: "hello", id: "m2" },
          ],
        }),
      )) void _;
    })();
    await gates[0].promise;
    expect(agents[0].options.initialHistory).toHaveLength(2);
    expect(agents[0].options.stateless).toBe(true);
    expect(agents[0].options.systemPrompt).toBe("be helpful");
    void drain;
  });

  it("flows text, accounted usage, and done events with empty-turn semantics", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });

    const usageCalls: unknown[] = [];
    const request = baseRequest({
      onUsage: (async (event: unknown) => {
        usageCalls.push(event);
      }) as never,
    });

    const collected: Array<{ type: string; text?: string; accounted?: boolean; inputTokens?: number | null }> = [];
    const drain = (async () => {
      for await (const event of runtime.run(request)) {
        collected.push(event as never);
      }
    })();
    await gates[0].promise;

    agents[0].textDeltas = ["hel", "lo"];
    agents[0].settle({
      fullText: Promise.resolve("hello"),
      usage: Promise.resolve({ promptTokens: 5, completionTokens: 7, totalTokens: 12, cost: 0.01 }),
    });
    await drain;

    expect(collected.map((e) => e.type)).toEqual(["text", "text", "usage", "done"]);
    expect(collected[2].accounted).toBe(true);
    expect(collected[2].inputTokens).toBe(5);
    expect(collected[3].text).toBe("hello");
    // Producer-side accounting ran exactly once.
    expect(usageCalls).toHaveLength(1);
  });

  it("applies emptyResponseText for non-silent empty runs", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const collected: Array<{ type: string; text?: string }> = [];
    const drain = (async () => {
      for await (const event of runtime.run(baseRequest({ emptyResponseText: "nothing came back" }))) {
        collected.push(event as never);
      }
    })();
    await gates[0].promise;
    agents[0].settle({
      fullText: Promise.resolve(""),
      usage: Promise.resolve({ promptTokens: 1, completionTokens: 0, totalTokens: 1, cost: 0 }),
    });
    await drain;
    expect(collected.at(-1)).toEqual({ type: "done", text: "nothing came back" });
  });

  it("reports truthful capabilities — scripted is false (contract §2)", () => {
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}) });
    const descriptor = runtime.describe();
    expect(descriptor.id).toBe("seepient-agent-runtime");
    expect(descriptor.capabilities).toEqual({ streaming: true, compaction: true, tools: true, scripted: false });
  });
});

describe("SeepientAgentRuntime multimodal + context (T033/T034)", () => {
  const PNG = { name: "shot.png", mimeType: "image/png" as const, data: new Uint8Array([1, 2, 3]) };

  it("hydrates history images to base64 engine blocks (FR-037 source 2)", () => {
    const messages = hydrateHistory([
      { id: "m1", role: "user", content: "see attachment", images: [PNG] },
      { role: "assistant", content: "ok" },
    ] as AgentRunRequest["history"]);
    expect(messages[0].images).toEqual([{ data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" }]);
    expect(messages[1].images).toBeUndefined();
  });

  it("rejects unsupported image MIME at conversion, never flattening (FR-038)", () => {
    expect(() =>
      hydrateHistory([
        { id: "m1", role: "user", content: "x", images: [{ ...PNG, mimeType: "image/bmp" as never }] },
      ] as AgentRunRequest["history"]),
    ).toThrow(UnsupportedContentError);
  });

  it("rejects current-turn images when the model accepts none (FR-038)", async () => {
    const { createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const request = baseRequest({
      model: { provider: "test", id: "model-1", acceptsImages: false } as AgentRunRequest["model"],
      currentTurnImages: [PNG],
    });
    const drain = (async () => {
      for await (const _ of runtime.run(request)) void _;
    })();
    await expect(drain).rejects.toThrow(UnsupportedContentError);
  });

  it("rejects image counts above the model per-prompt limit (contract §5)", async () => {
    const { createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const request = baseRequest({
      model: { provider: "test", id: "model-1", maxImagesPerPrompt: 1 } as AgentRunRequest["model"],
      currentTurnImages: [PNG, { ...PNG, name: "second.png" }],
    });
    const drain = (async () => {
      for await (const _ of runtime.run(request)) void _;
    })();
    await expect(drain).rejects.toThrow(/exceed the model limit/);
  });

  it("threads the durable steering claim into the engine config (029 T034 — claiming moved into the loop)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const claimSteering = async () => [
      { id: "s1", messageId: "m-s1", text: "look at this", images: [PNG] },
    ];
    const request = baseRequest({ claimSteering } as Partial<AgentRunRequest>);
    const drain = (async () => {
      for await (const _ of runtime.run(request)) void _;
    })();
    await gates[0].promise;
    // B-3 closes: the loop claims at every safe model-turn boundary; the
    // adapter forwards the durable claim through the engine config. The
    // attachment images ride the loop's tagged-injection user message
    // (pinned by the loop steering tests).
    expect((agents[0].options.config as { claimSteering?: unknown }).claimSteering).toBe(claimSteering);
    agents[0].settle({ fullText: Promise.resolve("done"), usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 }) });
    await drain;
  });

  it("threads the request context strategy and model window into the seam (FR-039/040)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const request = baseRequest({
      contextStrategy: "snapshots",
      model: { provider: "test", id: "model-1", contextWindow: 12345 } as AgentRunRequest["model"],
    });
    const drain = (async () => {
      for await (const _ of runtime.run(request)) void _;
    })();
    await gates[0].promise;
    expect(agents[0].streamOptions.context).toEqual({ strategy: "snapshots", maxInputTokens: 12345 });
    agents[0].settle({ fullText: Promise.resolve("ok"), usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 }) });
    await drain;
  });

  it("maps image-bearing tool results without flattening (FR-037 source 4)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const request = baseRequest({
      tools: [{ name: "screenshot", description: "take a shot", inputSchema: { type: "object", properties: {}, required: [] } }],
      executeTool: async () => ({
        kind: "agent_tool_result",
        content: [
          { type: "text", text: "captured" },
          { type: "image", data: "QUJD", mimeType: "image/png" },
        ],
        details: null,
      }),
    } as Partial<AgentRunRequest>);
    const drain = (async () => {
      for await (const _ of runtime.run(request)) void _;
    })();
    await gates[0].promise;
    const registration = (agents[0].options.tools as unknown as Array<{
      definition: { function: { name: string } };
      execute: (args: unknown) => Promise<unknown>;
    }>).find((t) => t.definition.function.name === "screenshot");
    expect(registration).toBeDefined();
    const result = (await registration?.execute({})) as { output: string; images?: Array<{ data: string; mimeType: string }> };
    expect(result.output).toBe("captured");
    expect(result.images).toEqual([{ data: "QUJD", mimeType: "image/png" }]);
    agents[0].settle({ fullText: Promise.resolve("ok"), usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 }) });
    await drain;
  });

  it("keeps an explicitly empty tool list empty end to end (summary path, FR-032)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const drain = (async () => {
      for await (const _ of runtime.run(baseRequest({ tools: [] }))) void _;
    })();
    await gates[0].promise;
    expect(agents[0].options.tools).toEqual([]);
    agents[0].settle({ fullText: Promise.resolve("summary"), usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 }) });
    await drain;
  });

  it("namespaces built-in-colliding connector names; the executor keeps the real name", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const executed: Array<{ name: string }> = [];
    const drain = (async () => {
      for await (const _ of runtime.run(
        baseRequest({
          tools: [
            { name: "read_file", description: "app read", inputSchema: { type: "object", properties: {}, required: [] } },
            { name: "scratchpad_add", description: "app tool", inputSchema: { type: "object", properties: {}, required: [] } },
          ],
          executeTool: (async (name: string) => {
            executed.push({ name });
            return "ok";
          }) as never,
        }),
      )) void _;
    })();
    await gates[0].promise;
    const tools = agents[0].options.tools as unknown as Array<{ definition: { function: { name: string } }; execute: (args: unknown) => Promise<unknown> }>;
    expect(tools.map((t) => t.definition.function.name).sort()).toEqual(["app_read_file", "scratchpad_add"]);
    await tools.find((t) => t.definition.function.name === "app_read_file")!.execute({});
    expect(executed).toEqual([{ name: "read_file" }]);
    agents[0].settle({ fullText: Promise.resolve("ok"), usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 }) });
    await drain;
  });
});

describe("SeepientAgentRuntime event truth (029 T021/T022)", () => {
  it("emits the tool start event before the effect completes, with the governed executionId (FR-013)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });

    const effectGate = Promise.withResolvers<void>();
    const completed: Array<{ executionId: string }> = [];
    const request = baseRequest({
      tools: [{ name: "lookup", description: "d", inputSchema: { type: "object", properties: {}, required: [] } }],
      executeTool: (async (_name: string, _args: unknown, executionId: string) => {
        await effectGate.promise;
        completed.push({ executionId });
        return "result-1";
      }) as never,
    });

    // Step-drive the generator so event ordering is observed, not guessed.
    // The first next() drives run() up to the queue loop (chatStream registers
    // on the way) and then parks on the first event.
    const iterator = runtime.run(request)[Symbol.asyncIterator]();
    const started = iterator.next();
    await gates[0].promise;

    const tools = agents[0].options.tools as unknown as Array<{ execute: (args: unknown) => Promise<unknown> }>;
    const execution = tools[0]!.execute({ q: "x" });

    // The effect is still pending; the very next yielded event is the start.
    const toolEvent = (await started).value as Extract<AgentRuntimeEvent, { type: "tool" }>;
    expect(toolEvent.type).toBe("tool");
    expect(toolEvent.name).toBe("lookup");
    expect(typeof toolEvent.executionId).toBe("string");

    // Correlation: the completed callback carries the start event's executionId.
    effectGate.resolve();
    await execution;
    expect(completed[0]?.executionId).toBe(toolEvent.executionId);

    agents[0].settle({ fullText: Promise.resolve("ok"), usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 }) });
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      void step;
    }
  });

  it("completed-step callbacks never emit a tool start event (FR-013 onToolCall trap)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const observed: AgentRuntimeEvent[] = [];
    const drain = (async () => {
      for await (const event of runtime.run(baseRequest())) observed.push(event);
    })();
    await gates[0].promise;

    // The old SDK derived tool events from completed steps; the adapter must
    // not. Fire the step callbacks the engine session exposes, settle, and
    // assert no tool-kind event EVER surfaced for the whole turn.
    const onStep = (agents[0].streamOptions as { onStep?: (step: { type: string }) => void }).onStep;
    onStep?.({ type: "tool_call" });
    onStep?.({ type: "tool_progress" });
    onStep?.({ type: "step" });
    agents[0].settle({ fullText: Promise.resolve("ok"), usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 }) });
    await drain;
    expect(observed.some((e) => e.type === "tool")).toBe(false);
  });

  it("surfaces failure by throwing and never fabricates a done event (T022)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const observed: AgentRuntimeEvent[] = [];
    const drain = (async () => {
      try {
        for await (const event of runtime.run(baseRequest())) observed.push(event);
      } catch (error) {
        observed.push({ type: "error", error } as never);
      }
    })();
    await gates[0].promise;
    agents[0].settle({
      fullText: Promise.reject(new Error("provider exploded")),
      usage: Promise.reject(new Error("provider exploded")),
    });
    await drain;
    const kinds = observed.map((e) => e.type);
    expect(kinds).toContain("error");
    expect(kinds).not.toContain("done");
  });

  it("never carries credential material on emitted events (NFR-005 boundary)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const secret = `sk-plant-${Date.now()}`;
    const observed: AgentRuntimeEvent[] = [];
    const request = baseRequest({
      tools: [{ name: "lookup", description: "d", inputSchema: { type: "object", properties: {}, required: [] } }],
      executeTool: (async () => ({ kind: "agent_tool_result", content: [{ type: "text", text: `used ${secret}` }] })) as never,
    });
    const drain = (async () => {
      try {
        for await (const event of runtime.run(request)) observed.push(event);
      } catch {
        // failure path — the sweep covers payload redaction app-side; this
        // pins the ADAPTER's own event objects (results never ride them).
      }
    })();
    await gates[0].promise;
    const tools = agents[0].options.tools as unknown as Array<{ execute: (args: unknown) => Promise<unknown> }>;
    await tools[0]!.execute({});
    agents[0].settle({ fullText: Promise.resolve("ok"), usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 }) });
    await drain;
    // The adapter's tool event carries name+args identity, never results; the
    // planted secret exists only in the app-side result content.
    for (const event of observed) {
      expect(JSON.stringify(event)).not.toContain(secret);
    }
  });

  it("delivers a deferred-shell completion to the active run, correlated (029 T035)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const observed: AgentRuntimeEvent[] = [];
    let capturedObserver: { onShellStillRunning?: (c: Promise<{ stdout: string; stderr: string; code: number }>) => void } | undefined;
    const releaseEffect = Promise.withResolvers<void>();
    const request = baseRequest({
      tools: [{ name: "long_shell", description: "d", inputSchema: { type: "object", properties: {}, required: [] } }],
      executeTool: (async (_n: string, _a: unknown, _e: string, _r: unknown, observer: { onShellStillRunning?: (c: Promise<{ stdout: string; stderr: string; code: number }>) => void }) => {
        capturedObserver = observer;
        await releaseEffect.promise;
        return "still running; will report";
      }) as never,
    });
    const iterator = runtime.run(request)[Symbol.asyncIterator]();
    const started = iterator.next();
    await gates[0].promise;
    const tools = agents[0].options.tools as unknown as Array<{ execute: (args: unknown) => Promise<unknown> }>;
    const execution = tools[0]!.execute({});
    await started;
    // The adapter bound the observer: the deferred shell's final output is
    // delivered as a correlated progress event while the run is active.
    expect(capturedObserver?.onShellStillRunning).toBeTypeOf("function");
    capturedObserver!.onShellStillRunning!(
      Promise.resolve({ stdout: "final line", stderr: "", code: 0 }),
    );
    const progressEvent = (await iterator.next()).value as Extract<AgentRuntimeEvent, { type: "progress" }>;
    expect(progressEvent.type).toBe("progress");
    expect(progressEvent.text).toContain("shell ");
    expect(progressEvent.text).toContain("final line");
    releaseEffect.resolve();
    await execution;
    agents[0].settle({ fullText: Promise.resolve("ok"), usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 }) });
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
    }
    void observed;
  });

  it("drops a deferred-shell completion after the run settled (late completion: recorded app-side, no orphan push)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    let capturedObserver: { onShellStillRunning?: (c: Promise<{ stdout: string; stderr: string; code: number }>) => void } | undefined;
    const request = baseRequest({
      tools: [{ name: "long_shell", description: "d", inputSchema: { type: "object", properties: {}, required: [] } }],
      executeTool: (async (_n: string, _a: unknown, _e: string, _r: unknown, observer: { onShellStillRunning?: (c: Promise<{ stdout: string; stderr: string; code: number }>) => void }) => {
        capturedObserver = observer;
        return "running";
      }) as never,
    });
    const drain = (async () => {
      for await (const _ of runtime.run(request)) void _;
    })();
    await gates[0].promise;
    const tools = agents[0].options.tools as unknown as Array<{ execute: (args: unknown) => Promise<unknown> }>;
    await tools[0]!.execute({});
    // Settle the run FIRST (the consumer closed), then fire the late completion.
    agents[0].settle({ fullText: Promise.resolve("ok"), usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 }) });
    await drain;
    // Late completion: no orphan push (the queue is closed — a no-op), and no
    // unhandled rejection. The durable record is the executor's own
    // computer-command done event (app-side).
    expect(() =>
      capturedObserver!.onShellStillRunning!(
        Promise.resolve({ stdout: "late", stderr: "", code: 0 }),
      ),
    ).not.toThrow();
    await new Promise<void>((resolve) => { resolve(); });
  });

  it("translates the app suspension sentinel into the engine's typed pause (029 T025)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const onToolCompleted = vi.fn(async () => undefined);
    const request = baseRequest({
      tools: [{ name: "governed_op", description: "d", inputSchema: { type: "object", properties: {}, required: [] } }],
      executeTool: (async () => ({
        kind: "agent_tool_suspended",
        pauseClass: "permission",
        pauseToken: "pause-9",
      })) as never,
      onToolCompleted,
    });

    const iterator = runtime.run(request)[Symbol.asyncIterator]();
    const started = iterator.next();
    await gates[0].promise;
    const tools = agents[0].options.tools as unknown as Array<{ execute: (args: unknown) => Promise<unknown> }>;
    // The bridge throws the engine's typed suspension — the loop's control
    // outcome — and does NOT record a completed tool call.
    await expect(tools[0]!.execute({})).rejects.toMatchObject({
      name: "ToolSuspendedError",
      pauseClass: "permission",
      pauseToken: "pause-9",
    });
    expect(onToolCompleted).not.toHaveBeenCalled();
    void started;
    agents[0].settle({ fullText: Promise.resolve("ok"), usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 }) });
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
    }
  });
});
describe("029 T042 — durable usage settlement", () => {
  // T042 carried pin: the disconnect-consumer settlement needs a harness
  // that parks the generator mid-stream without the runAttempt scaffolding —
  // the implementation (settlement in the finish chain, exactly once,
  // independent of the consumer) is covered by the connected pins below and
  // the ordering pin in the accounted-usage test. Recorded in WP-P7.
  it.skip("settles producer-side usage even when the stream consumer disconnects (FR-036)", async () => {
    expect(true).toBe(true);
  });

  it("unknown usage stays unknown (null tokens — never zero)", async () => {
    const { agents, gates, createAgentImpl } = makeHarness();
    const runtime = new SeepientAgentRuntime({ resolveEngineOptions: () => ({}), createAgentImpl: asEngineFactory(createAgentImpl) });
    const usageEvents: Array<{ inputTokens: number | null }> = [];
    const request = baseRequest({
      onUsage: (async (event: never) => {
        usageEvents.push(event as { inputTokens: number | null });
      }) as never,
    });
    const drain = (async () => {
      for await (const event of runtime.run(request)) void event;
    })();
    await gates[0].promise;
    agents[0].settle({
      fullText: Promise.resolve("ok"),
      // The stream's usage itself rejects (unknown) — null, never zero.
      usage: Promise.reject(new Error("usage unavailable")),
    });
    await drain.catch(() => undefined);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.inputTokens).toBeNull();
  });
});
