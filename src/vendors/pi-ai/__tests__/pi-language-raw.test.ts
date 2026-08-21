import { describe, it, expect, vi } from "vitest";
import { PiLanguageRaw } from "../pi-language-raw.js";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { InferenceTarget } from "../../../foundations/contracts/backend-ports.js";
import type {
  CredentialHandle,
  CredentialLease,
} from "../../../foundations/contracts/credential-store.js";

function createMockCredential(apiKey = "sk-test", onRelease?: () => void): CredentialHandle {
  let activeLeases = 0;
  return {
    id: "cred-test",
    ref: { kind: "env", name: "TEST_KEY" },
    get activeLeaseCount() {
      return activeLeases;
    },
    async isResolvable() {
      return true;
    },
    acquireLease() {
      activeLeases++;
      const lease: CredentialLease = {
        leaseId: `lease-${activeLeases}`,
        isReleased: false,
        async secret() {
          return { kind: "api_key", value: apiKey };
        },
        async release() {
          (lease as any).isReleased = true;
          activeLeases = Math.max(0, activeLeases - 1);
          if (onRelease) onRelease();
        },
      };
      return lease;
    },
  };
}

describe("PiLanguageRaw backend (QS-P3.3)", () => {
  it("streams text tokens and terminates with finish event and usage", async () => {
    let released = false;
    const credential = createMockCredential("sk-test", () => {
      released = true;
    });

    const mockModels = {
      getModel: () => ({ id: "gpt-4o", provider: "openai" }),
      stream: async function* (): AsyncIterable<AssistantMessageEvent> {
        const dummyMsg: any = { role: "assistant", content: [] };
        yield { type: "start", partial: dummyMsg };
        yield { type: "text_start", contentIndex: 0, partial: dummyMsg };
        yield { type: "text_delta", contentIndex: 0, delta: "Hello ", partial: dummyMsg };
        yield { type: "text_delta", contentIndex: 0, delta: "World!", partial: dummyMsg };
        yield { type: "text_end", contentIndex: 0, content: "Hello World!", partial: dummyMsg };
        yield {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            api: "openai-completions",
            provider: "openai",
            model: "gpt-4o",
            content: [{ type: "text", text: "Hello World!" }],
            stopReason: "stop",
            timestamp: Date.now(),
            usage: {
              input: 5,
              output: 3,
              totalTokens: 8,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
            },
          },
        };
      },
    };

    const backend = new PiLanguageRaw(mockModels as any);
    const target: InferenceTarget = {
      providerAccount: "openai-work",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential,
    };

    const events = [];
    for await (const ev of backend.chatStream(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      events.push(ev);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe("start");
    const deltaEvents = events.filter((e) => e.type === "content_block_delta");
    expect(deltaEvents.length).toBe(2);
    expect((deltaEvents[0] as any).delta.text).toBe("Hello ");

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toBeDefined();
    expect((finish as any).stopReason).toBe("end_turn");
    expect((finish as any).usage?.totalTokens).toBe(8);
    expect((finish as any).usage?.cost).toBe(0.003);
    expect(released).toBe(true);
  });

  it("chat() uses authoritative message content and usage from done event", async () => {
    const credential = createMockCredential();
    const mockModels = {
      getModel: () => ({ id: "gpt-4o", provider: "openai" }),
      stream: async function* (): AsyncIterable<AssistantMessageEvent> {
        const dummyMsg: any = { role: "assistant", content: [] };
        yield { type: "text_start", contentIndex: 0, partial: dummyMsg };
        yield { type: "text_delta", contentIndex: 0, delta: "Direct chat response", partial: dummyMsg };
        yield { type: "text_end", contentIndex: 0, content: "Direct chat response", partial: dummyMsg };
        yield {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            api: "openai-completions",
            provider: "openai",
            model: "gpt-4o",
            content: [{ type: "text", text: "Direct chat response" }],
            stopReason: "stop",
            timestamp: Date.now(),
            usage: {
              input: 4,
              output: 4,
              totalTokens: 8,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        };
      },
    };

    const backend = new PiLanguageRaw(mockModels as any);
    const target: InferenceTarget = {
      providerAccount: "openai-work",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential,
    };

    const resp = await backend.chat(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "tell me" }] }],
    });

    expect(resp.message.content[0].type).toBe("text");
    expect((resp.message.content[0] as any).text).toBe("Direct chat response");
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.usage?.totalTokens).toBe(8);
  });

  it("streams reasoning thinking tokens and captures signature triple", async () => {
    const credential = createMockCredential();
    const mockModels = {
      getModel: () => ({ id: "claude-3-7-sonnet", provider: "anthropic", api: "anthropic-messages" }),
      streamSimple: async function* (): AsyncIterable<AssistantMessageEvent> {
        const dummyMsg: any = { role: "assistant", content: [] };
        yield { type: "thinking_start", contentIndex: 0, partial: dummyMsg };
        yield { type: "thinking_delta", contentIndex: 0, delta: "Analyzing input...", partial: dummyMsg };
        const dummyMsgEnd: any = {
          role: "assistant",
          content: [{ type: "thinking", thinkingSignature: "sig-anthropic-123" }],
        };
        yield { type: "thinking_end", contentIndex: 0, content: "Analyzing input...", partial: dummyMsgEnd };
        yield { type: "toolcall_start", contentIndex: 1, partial: dummyMsg };
        yield { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"/a.txt"}', partial: dummyMsg };
        yield {
          type: "toolcall_end",
          contentIndex: 1,
          toolCall: { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/a.txt" } },
          partial: dummyMsg,
        };
        yield {
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-3-7-sonnet",
            content: [
              {
                type: "thinking",
                thinking: "Analyzing input...",
                thinkingSignature: "sig-anthropic-123",
              },
              {
                type: "toolCall",
                id: "call_1",
                name: "read_file",
                arguments: { path: "/a.txt" },
              },
            ],
            stopReason: "toolUse",
            timestamp: Date.now(),
            usage: {
              input: 10,
              output: 15,
              reasoning: 8,
              totalTokens: 25,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        };
      },
    };

    const backend = new PiLanguageRaw(mockModels as any);
    const target: InferenceTarget = {
      providerAccount: "anthropic-main",
      upstreamProvider: "anthropic",
      model: "claude-3-7-sonnet",
      credential,
    };

    const resp = await backend.chat(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "read file" }] }],
      thinkingLevel: "high",
    });

    expect(resp.stopReason).toBe("tool_use");
    expect(resp.message.content.length).toBe(2);

    const reasoning = resp.message.content[0];
    expect(reasoning.type).toBe("reasoning");
    expect((reasoning as any).signature).toBe("sig-anthropic-123");
    expect((reasoning as any).signatureProvenance).toEqual({
      adapter: "pi-ai",
      providerApi: "anthropic-messages",
      upstreamProvider: "anthropic",
    });

    const toolUse = resp.message.content[1];
    expect(toolUse.type).toBe("tool_use");
    expect((toolUse as any).id).toBe("call_1");
    expect((toolUse as any).name).toBe("read_file");
    expect((toolUse as any).input).toEqual({ path: "/a.txt" });

    // Test streaming signature capture on content_block_stop
    const events = [];
    for await (const event of backend.chatStream(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "read file" }] }],
      thinkingLevel: "high",
    })) {
      events.push(event);
    }

    const reasoningStop = events.find((e) => e.type === "content_block_stop" && e.index === 0) as any;
    expect(reasoningStop).toBeDefined();
    expect(reasoningStop.signature).toBe("sig-anthropic-123");
    expect(reasoningStop.signatureProvenance).toEqual({
      adapter: "pi-ai",
      providerApi: "anthropic-messages",
      upstreamProvider: "anthropic",
    });
  });

  it("emits real toolcall name and id during streaming toolcall_start", async () => {
    const credential = createMockCredential();
    const mockModels = {
      getModel: () => ({ id: "gpt-4o", provider: "openai" }),
      stream: async function* (): AsyncIterable<AssistantMessageEvent> {
        const partialWithTool: any = {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_exec_123", name: "execute_shell_command", arguments: {} },
          ],
        };
        yield { type: "start", partial: partialWithTool };
        yield { type: "toolcall_start", contentIndex: 0, partial: partialWithTool };
        yield { type: "toolcall_delta", contentIndex: 0, delta: '{"cmd":"ls"}', partial: partialWithTool };
        yield {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: { type: "toolCall", id: "call_exec_123", name: "execute_shell_command", arguments: { cmd: "ls" } },
          partial: partialWithTool,
        };
        yield {
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            api: "openai-completions",
            provider: "openai",
            model: "gpt-4o",
            content: [
              { type: "toolCall", id: "call_exec_123", name: "execute_shell_command", arguments: { cmd: "ls" } },
            ],
            stopReason: "toolUse",
            timestamp: Date.now(),
            usage: { input: 12, output: 8, totalTokens: 20, cacheRead: 5, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          },
        };
      },
    };

    const backend = new PiLanguageRaw(mockModels as any);
    const target: InferenceTarget = {
      providerAccount: "work-openai",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential,
    };

    const events = [];
    for await (const ev of backend.chatStream(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "run ls" }] }],
    })) {
      events.push(ev);
    }

    const toolStart = events.find(
      (e) => e.type === "content_block_start" && (e as any).block.type === "tool_use",
    );
    expect(toolStart).toBeDefined();
    expect((toolStart as any).block.id).toBe("call_exec_123");
    expect((toolStart as any).block.name).toBe("execute_shell_command");

    const finish = events.find((e) => e.type === "finish");
    expect((finish as any).usage?.cachedPromptTokens).toBe(5);
  });

  it("handles custom/Ollama/vLLM models not in static catalog with complete cost and baseUrl overrides", async () => {
    let capturedModel: any;
    const credential = createMockCredential("sk-custom");

    const mockModels = {
      getModel: () => undefined, // Model is not in static Pi catalog!
      stream: (model: any) => {
        capturedModel = model;
        return (async function* () {
          yield {
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Custom response" }],
              usage: { input: 10, output: 5, totalTokens: 15, cost: { input: 0, output: 0, total: 0 } },
            },
          };
        })();
      },
    };

    const backend = new PiLanguageRaw(mockModels as any);
    const target: InferenceTarget = {
      providerAccount: "local-ollama",
      upstreamProvider: "ollama",
      model: "llama3.3:70b",
      baseUrl: "http://localhost:11434/v1",
      credential,
    };

    const events = [];
    for await (const ev of backend.chatStream(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      events.push(ev);
    }

    expect(capturedModel).toBeDefined();
    expect(capturedModel.id).toBe("llama3.3:70b");
    expect(capturedModel.baseUrl).toBe("http://localhost:11434/v1");
    expect(capturedModel.provider).toBe("openai"); // Mapped to openai provider for custom/Ollama
    expect(capturedModel.cost).toBeDefined();
    expect(Array.isArray(capturedModel.cost.tiers)).toBe(true); // Guarantees calculateCost doesn't crash!
  });

  it("handles built-in pi-ai catalog providers like opencode without requiring an explicit baseUrl", async () => {
    let capturedModel: any;
    const credential = createMockCredential("sk-opencode");

    // Real PiLanguageRaw with actual builtinModels
    const backend = new PiLanguageRaw();
    const target: InferenceTarget = {
      providerAccount: "my-opencode-account",
      upstreamProvider: "opencode",
      model: "hy3-free",
      credential,
    };

    // Spy on stream to verify prepared invocation
    (backend as any).models.stream = (model: any) => {
      capturedModel = model;
      return (async function* () {
        yield {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello from OpenCode" }],
            usage: { input: 5, output: 5, totalTokens: 10 },
          },
        };
      })();
    };

    const events = [];
    for await (const ev of backend.chatStream(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      events.push(ev);
    }

    expect(capturedModel).toBeDefined();
    expect(capturedModel.id).toBe("hy3-free");
    expect(capturedModel.provider).toBe("opencode");
    expect(capturedModel.baseUrl).toBe("https://opencode.ai/zen/v1");
  });

  it("extracts access token from nested piAuthContext in pi_oauth secrets", async () => {
    let capturedApiKey: string | undefined;
    const mockCredential: CredentialHandle = {
      id: "oauth-test",
      ref: { kind: "seepient", id: "oauth-test" },
      activeLeaseCount: 0,
      async isResolvable() { return true; },
      acquireLease() {
        return {
          leaseId: "lease-oauth",
          isReleased: false,
          async secret() {
            return {
              kind: "pi_oauth",
              piAuthContext: {
                access: "oauth-bearer-token-12345",
                refresh: "refresh-token-xyz",
                expires: Date.now() + 3600_000,
              },
            };
          },
          async release() {},
        };
      },
    };

    const mockModels = {
      getModel: (_p: any, _m: any) => ({ id: "claude-3-5-sonnet", provider: "anthropic" }),
      stream: (model: any, _ctx: any, opts: any) => {
        capturedApiKey = opts?.apiKey;
        return (async function* () {
          yield {
            type: "done",
            reason: "stop",
            message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          };
        })();
      },
    };

    const backend = new PiLanguageRaw(mockModels as any);
    const target: InferenceTarget = {
      providerAccount: "oauth-account",
      upstreamProvider: "anthropic",
      model: "claude-3-5-sonnet",
      credential: mockCredential,
    };

    for await (const _ of backend.chatStream(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      // consume
    }

    expect(capturedApiKey).toBe("oauth-bearer-token-12345");
  });

  it("refreshes expired OAuth tokens and persists rotated credentials to credentialStore", async () => {
    const authAdapter = await import("../pi-auth-adapter.js");
    const mockFlow = {
      name: "Anthropic OAuth",
      refresh: vi.fn(async (cred: any) => {
        expect(cred.type).toBe("oauth");
        expect(cred.refresh).toBe("valid-refresh-token");
        return {
          type: "oauth",
          access: "refreshed-oauth-token-999",
          refresh: "new-refresh-token-000",
          expires: Date.now() + 3600_000,
        };
      }),
    };
    vi.spyOn(authAdapter, "getOAuthFlow").mockResolvedValue(mockFlow as any);

    let capturedApiKey: string | undefined;
    const persistedRecords: any[] = [];
    const mockStore = {
      put: async (id: string, record: any) => {
        persistedRecords.push({ id, ...record });
      },
    };

    const mockCredential: CredentialHandle = {
      id: "oauth-test-expired",
      ref: { kind: "seepient", id: "oauth-test-expired" },
      activeLeaseCount: 0,
      async isResolvable() { return true; },
      acquireLease() {
        return {
          leaseId: "lease-oauth-expired",
          isReleased: false,
          async secret() {
            return {
              kind: "pi_oauth",
              piAuthContext: {
                access: "expired-access-token",
                refresh: "valid-refresh-token",
                expires: Date.now() - 10_000, // expired
              },
            };
          },
          async release() {},
        };
      },
    };

    const mockModels = {
      getProviders: () => [{ id: "anthropic" }],
      getModel: (_p: any, _m: any) => ({ id: "claude-3-5-sonnet", provider: "anthropic" }),
      stream: (_model: any, _ctx: any, opts: any) => {
        capturedApiKey = opts?.apiKey;
        return (async function* () {
          yield {
            type: "done",
            reason: "stop",
            message: { role: "assistant", content: [{ type: "text", text: "refreshed ok" }] },
          };
        })();
      },
    };

    const backend = new PiLanguageRaw(mockModels as any, mockStore);
    const target: InferenceTarget = {
      providerAccount: "oauth-account-expired",
      upstreamProvider: "anthropic",
      model: "claude-3-5-sonnet",
      credential: mockCredential,
    };

    for await (const _ of backend.chatStream(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      // consume
    }

    // Verify token was refreshed and passed to stream
    expect(capturedApiKey).toBe("refreshed-oauth-token-999");
    expect(persistedRecords.length).toBe(1);
    expect(persistedRecords[0].id).toBe("oauth-account-expired");
    expect(persistedRecords[0].access).toBe("refreshed-oauth-token-999");
    expect(persistedRecords[0].refresh).toBe("new-refresh-token-000");
  });

  it("throws oauth_expired InferenceError when token refresh fails", async () => {
    const authAdapter = await import("../pi-auth-adapter.js");
    const mockFlow = {
      name: "Anthropic OAuth",
      refresh: vi.fn(async () => {
        throw new Error("invalid_grant: token revoked");
      }),
    };
    vi.spyOn(authAdapter, "getOAuthFlow").mockResolvedValue(mockFlow as any);

    const mockCredential: CredentialHandle = {
      id: "oauth-test-revoked",
      ref: { kind: "seepient", id: "oauth-test-revoked" },
      activeLeaseCount: 0,
      async isResolvable() { return true; },
      acquireLease() {
        return {
          leaseId: "lease-oauth-revoked",
          isReleased: false,
          async secret() {
            return {
              kind: "pi_oauth",
              piAuthContext: {
                access: "expired-access-token",
                refresh: "revoked-refresh-token",
                expires: Date.now() - 10_000,
              },
            };
          },
          async release() {},
        };
      },
    };

    const mockModels = {
      getProviders: () => [{ id: "anthropic" }],
      getModel: (_p: any, _m: any) => ({ id: "claude-3-5-sonnet", provider: "anthropic" }),
      stream: () => (async function* () {})(),
    };

    const backend = new PiLanguageRaw(mockModels as any);
    const target: InferenceTarget = {
      providerAccount: "oauth-account-revoked",
      upstreamProvider: "anthropic",
      model: "claude-3-5-sonnet",
      credential: mockCredential,
    };

    await expect(async () => {
      for await (const _ of backend.chatStream(target, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      })) {}
    }).rejects.toThrow(/OAuth session for "oauth-account-revoked" expired/);
  });
});

