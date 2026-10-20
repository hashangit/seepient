/**
 * S08 adapter unit pins (spec 029, M02 T028): targeted abort (RT01), the
 * empty-tool-list rule (FR-032), pure hydration (FR-034), and the
 * text/usage/done event flow — all against a controllable engine double via
 * the adapter's DI seam (no real providers, no network, no timers).
 */
import { describe, expect, it } from "vitest";
import { createSeepient } from "seepient-engine/dist/transport/sdk/seepient.js";
import { SeepientAgentRuntime, hydrateHistory } from "../seepient-agent-runtime.js";
import type { AgentRunRequest } from "@seepients/adapter-kit";
import type { CreateSeepientOptions } from "seepient-engine/dist/foundations/types.js";

interface TestStreamPayload {
  fullText: Promise<string>;
  usage: Promise<{ promptTokens: number; completionTokens: number; totalTokens: number; cost: number }>;
}

interface TestAgent {
  aborted: boolean;
  options: CreateSeepientOptions;
  streamOptions: { onText?: (delta: string) => void };
  settled: PromiseWithResolvers<TestStreamPayload>;
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
    const agent = {
      aborted: false,
      options,
      streamOptions: {},
      settled: Promise.withResolvers<TestStreamPayload>(),
      settle(payload: TestStreamPayload) {
        this.settled.resolve(payload);
      },
      abort() {
        this.aborted = true;
      },
      chatStream(prompt: string, streamOptions: { onText?: (delta: string) => void }): Promise<never> {
        void prompt;
        this.streamOptions = streamOptions;
        return this.settled.promise.then((payload) => {
          // Test double: the adapter consumes only fullText/usage on the
          // stream result — the rest is unreachable surface for these pins.
          const streamResult = {
            textStream: (async function* () {})(),
            steps: (async function* () {})(),
            fullText: payload.fullText,
            usage: payload.usage,
            finishReason: Promise.resolve("stop"),
            abort: () => agent.abort(),
            toResponse: () => {
              throw new Error("not used by the adapter");
            },
            toSSEStream: () => {
              throw new Error("not used by the adapter");
            },
          };
          return streamResult as never;
        });
      },
    } satisfies TestAgent;
    const index = agents.length;
    agents.push(agent);
    const originalChatStream = agent.chatStream.bind(agent);
    agent.chatStream = (prompt, streamOptions) => {
      const real = originalChatStream(prompt, streamOptions);
      gates[index]?.resolve();
      return real;
    };
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

    const onText = agents[0].streamOptions.onText;
    expect(typeof onText).toBe("function");
    onText?.("hel");
    onText?.("lo");
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
