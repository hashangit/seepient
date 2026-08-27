import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../agent-loop.js";
import { ProviderRuntime } from "../providers/provider-runtime.js";
import { MemoryCredentialStore } from "../providers/credentials/memory-credential-store.js";
import { ProviderConfigStore } from "../providers/config-store/provider-config-store.js";
import { AggregateInferenceAdapter } from "../../capabilities/inference/aggregate-adapter.js";
import { createHookExecutor } from "../hooks.js";
import type { LanguageBackend } from "../../foundations/contracts/backend-ports.js";

describe("Agent Loop Execution via ProviderRuntime (QS-P5.3c)", () => {
  it("streams language tokens through ProviderRuntime.executeLanguage", async () => {
    let capturedReq: any;
    const mockLanguageBackend: LanguageBackend = {
      chatStream: async function* (_target, req) {
        capturedReq = req;
        yield {
          type: "start",
          resolvedModel: {
            providerAccount: "main-account",
            modelId: "gpt-4o",
          },
        };
        yield {
          type: "content_block_start",
          index: 0,
          block: {
            type: "text",
            text: "",
          },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hello from ProviderRuntime!",
          },
        };
        yield {
          type: "content_block_stop",
          index: 0,
        };
        yield {
          type: "finish",
          stopReason: "end_turn",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
        };
      },
      chat: async () => ({
        message: { role: "assistant", content: [] },
        stopReason: "end_turn",
      }),
    };

    const adapter = new AggregateInferenceAdapter({
      language: mockLanguageBackend,
    });

    const credStore = new MemoryCredentialStore();
    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay({
      providers: {
        "main-account": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "none" },
        },
      },
      modelAssignments: {
        text: {
          standard: {
            providerAccount: "main-account",
            model: "gpt-4o",
          },
        },
      },
    }, 0);

    const runtime = new ProviderRuntime({
      configStore,
      credentialStore: credStore,
      adapter,
    });
    const steps: any[] = [];
    const result = await runAgentLoop({
      runtime,
      model: "gpt-4o",
      messages: [{ id: "1", role: "user", content: "Hi", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 3,
      hooks: createHookExecutor(),
      onStep: (step) => steps.push(step),
    });

    const lastMessage = result.messages[result.messages.length - 1];
    expect(lastMessage.content).toBe("Hello from ProviderRuntime!");
    expect(result.usage.totalTokens).toBe(15);
    expect(steps.some((s) => s.type === "text_delta" && s.content === "Hello from ProviderRuntime!")).toBe(true);
    expect(capturedReq.messages.length).toBe(1);
    expect(capturedReq.messages[0].content[0].text).toBe("Hi");
  });

  it("handles multi-step tool call and response loops converting canonical messages cleanly", async () => {
    let callCount = 0;
    const receivedRequests: any[] = [];

    const mockLanguageBackend: LanguageBackend = {
      chatStream: async function* (_target, req) {
        callCount++;
        receivedRequests.push(JSON.parse(JSON.stringify(req)));

        if (callCount === 1) {
          // Step 1: LLM decides to call a tool
          yield {
            type: "start",
            resolvedModel: { providerAccount: "main-account", modelId: "gpt-4o" },
          };
          yield {
            type: "content_block_start",
            index: 0,
            block: {
              type: "tool_use",
              id: "call_abc123",
              name: "calculator",
              input: { expression: "2 + 2" },
            },
          };
          yield {
            type: "content_block_stop",
            index: 0,
          };
          yield {
            type: "finish",
            stopReason: "tool_use",
            usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          };
        } else {
          // Step 2: LLM returns final response after tool execution
          yield {
            type: "start",
            resolvedModel: { providerAccount: "main-account", modelId: "gpt-4o" },
          };
          yield {
            type: "content_block_start",
            index: 0,
            block: { type: "text", text: "" },
          };
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "The answer is 4." },
          };
          yield {
            type: "content_block_stop",
            index: 0,
          };
          yield {
            type: "finish",
            stopReason: "end_turn",
            usage: { inputTokens: 35, outputTokens: 8, totalTokens: 43 },
          };
        }
      },
      chat: async () => ({
        message: { role: "assistant", content: [] },
        stopReason: "end_turn",
      }),
    };

    const adapter = new AggregateInferenceAdapter({ language: mockLanguageBackend });
    const credStore = new MemoryCredentialStore();
    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay({
      providers: {
        "main-account": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "none" },
        },
      },
      modelAssignments: {
        text: {
          standard: { providerAccount: "main-account", model: "gpt-4o" },
        },
      },
    }, 0);

    const runtime = new ProviderRuntime({
      configStore,
      credentialStore: credStore,
      adapter,
    });

    const mockToolDefs = [
      {
        type: "function" as const,
        function: {
          name: "calculator",
          description: "Calculate arithmetic",
          parameters: {
            type: "object" as const,
            properties: { expression: { type: "string" } },
            required: ["expression"],
          },
        },
      },
    ];

    const result = await runAgentLoop({
      runtime,
      model: "gpt-4o",
      messages: [{ id: "1", role: "user", content: "What is 2+2?", timestamp: Date.now() }],
      toolDefs: mockToolDefs,
      maxSteps: 5,
      hooks: createHookExecutor(),
    });

    expect(callCount).toBe(2);
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.content).toBe("The answer is 4.");

    // Assert second call carried tool_use block and tool_result block in converted canonical context
    const step2Req = receivedRequests[1];
    expect(step2Req.messages.some((m: any) => m.role === "tool")).toBe(true);
  });

  it("fails loudly with EMPTY_COMPLETION when provider yields 0 tokens and no tool calls", async () => {
    const mockLanguageBackend: LanguageBackend = {
      chatStream: async function* () {
        yield {
          type: "start",
          resolvedModel: { providerAccount: "main-account", modelId: "gpt-4o" },
        };
        // No text delta or tool calls — finishes immediately
        yield {
          type: "finish",
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
        };
      },
      chat: async () => ({
        message: { role: "assistant", content: [] },
        stopReason: "end_turn",
      }),
    };

    const adapter = new AggregateInferenceAdapter({ language: mockLanguageBackend });
    const credStore = new MemoryCredentialStore();
    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay({
      providers: {
        "main-account": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "none" },
        },
      },
      modelAssignments: {
        text: {
          standard: { providerAccount: "main-account", model: "gpt-4o" },
        },
      },
    }, 0);

    const runtime = new ProviderRuntime({
      configStore,
      credentialStore: credStore,
      adapter,
    });

    const initialMessages = [{ id: "1", role: "user" as const, content: "Hi", timestamp: Date.now() }];
    const result = await runAgentLoop({
      runtime,
      model: "gpt-4o",
      messages: initialMessages,
      toolDefs: [],
      maxSteps: 3,
      hooks: createHookExecutor(),
    });

    expect(result.finishReason).toBe("error");
    expect(result.error?.code).toBe("EMPTY_COMPLETION");
    expect(result.error?.retryable).toBe(true);
    // Must NOT push an empty assistant message
    expect(result.messages.length).toBe(1);
  });

  it("extracts in-band XML tool calls (<tool_call>) from content", async () => {
    const { extractInBandToolCalls } = await import("../agent-loop.js");
    const raw = `Let me check the weather.\n<tool_call>\n{"name": "web_search", "arguments": {"query": "weather in Tokyo"}}\n</tool_call>\nDone.`;
    const extracted = extractInBandToolCalls(raw);
    expect(extracted.toolCalls).toHaveLength(1);
    expect(extracted.toolCalls[0].name).toBe("web_search");
    expect(JSON.parse(extracted.toolCalls[0].arguments)).toEqual({ query: "weather in Tokyo" });
    expect(extracted.remainingText).toContain("Let me check the weather.");
  });

  it("extracts in-band Markdown tool calls (```tool_call) from content", async () => {
    const { extractInBandToolCalls } = await import("../agent-loop.js");
    const raw = `I will run the command:\n\`\`\`tool_call\n{\n  "name": "execute_shell_command",\n  "arguments": {"command": "ls -la"}\n}\n\`\`\``;
    const extracted = extractInBandToolCalls(raw);
    expect(extracted.toolCalls).toHaveLength(1);
    expect(extracted.toolCalls[0].name).toBe("execute_shell_command");
    expect(JSON.parse(extracted.toolCalls[0].arguments)).toEqual({ command: "ls -la" });
  });
});
