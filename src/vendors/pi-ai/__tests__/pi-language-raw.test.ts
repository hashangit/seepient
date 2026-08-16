import { describe, it, expect, vi } from "vitest";
import { PiLanguageRaw } from "../pi-language-raw.js";
import type { InferenceTarget } from "../../../foundations/contracts/backend-ports.js";
import type {
  CredentialHandle,
  CredentialLease,
} from "../../../foundations/contracts/credential-store.js";
import { InferenceError } from "../../../foundations/errors.js";

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
      stream: async function* () {
        yield { type: "text_start" };
        yield { type: "text_delta", content: "Hello " };
        yield { type: "text_delta", content: "World!" };
        yield { type: "text_end" };
        yield {
          type: "done",
          message: {
            usage: { promptTokens: 5, completionTokens: 3 },
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
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toBeDefined();
    expect((finish as any).stopReason).toBe("end_turn");
    expect((finish as any).usage?.totalTokens).toBe(8);
    expect(released).toBe(true);
  });

  it("chat() accumulates stream events into complete response", async () => {
    const credential = createMockCredential();
    const mockModels = {
      getModel: () => ({ id: "gpt-4o", provider: "openai" }),
      stream: async function* () {
        yield { type: "text_start" };
        yield { type: "text_delta", content: "Direct chat response" };
        yield { type: "text_end" };
        yield {
          type: "done",
          message: {
            usage: { promptTokens: 4, completionTokens: 4 },
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
    expect(resp.usage.totalTokens).toBe(8);
  });

  it("streams reasoning thinking tokens and tool calls", async () => {
    const credential = createMockCredential();
    const mockModels = {
      getModel: () => ({ id: "claude-3-7-sonnet", provider: "anthropic" }),
      stream: async function* () {
        yield { type: "thinking_start" };
        yield { type: "thinking_delta", content: "Analyzing input..." };
        yield { type: "thinking_end" };
        yield { type: "toolcall_start", toolCall: { id: "call_1", name: "read_file" } };
        yield { type: "toolcall_delta", delta: '{"path":' };
        yield { type: "toolcall_delta", delta: '"/a.txt"}' };
        yield { type: "toolcall_end" };
        yield {
          type: "done",
          reason: "toolUse",
          message: {
            usage: { promptTokens: 10, completionTokens: 15 },
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

    const events = [];
    for await (const ev of backend.chatStream(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "read file" }] }],
      thinkingLevel: "high",
    })) {
      events.push(ev);
    }

    const reasoningStart = events.find(
      (e) => e.type === "content_block_start" && (e as any).block.type === "reasoning",
    );
    expect(reasoningStart).toBeDefined();

    const toolUseStart = events.find(
      (e) => e.type === "content_block_start" && (e as any).block.type === "tool_use",
    );
    expect(toolUseStart).toBeDefined();

    const finish = events.find((e) => e.type === "finish");
    expect((finish as any).stopReason).toBe("tool_use");
  });
});
