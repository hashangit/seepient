import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LegacyLanguageAdapter } from "../legacy-language-adapter.js";
import { LegacyMediaAdapter } from "../legacy-media-adapter.js";
import type { InferenceTarget } from "../../../../foundations/contracts/backend-ports.js";
import type { CredentialHandle, CredentialLease, CredentialSecret } from "../../../../foundations/contracts/credential-store.js";
import { InferenceError } from "../../../../foundations/errors.js";
import * as mediaModule from "../../../media/media.js";
import { OpenAIProvider } from "../../../llm/openai.js";

function createMockCredential(secretValue: CredentialSecret, onRelease?: () => void): CredentialHandle {
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
          return secretValue;
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

describe("legacy adapters (QS-P1.5)", () => {
  it("LegacyLanguageAdapter rejects unsupported upstream provider with InferenceError and releases lease", async () => {
    const adapter = new LegacyLanguageAdapter();
    let released = false;
    const credential = createMockCredential({ kind: "api_key", key: "sk-test" }, () => {
      released = true;
    });

    const target: InferenceTarget = {
      providerAccount: "unsupported-acc",
      upstreamProvider: "unsupported-provider",
      model: "test-model",
      credential,
    };

    await expect(
      adapter.chat(target, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    ).rejects.toThrow(InferenceError);

    expect(released).toBe(true);
    expect(credential.activeLeaseCount).toBe(0);
  });

  it("LegacyLanguageAdapter rejects non-api_key credentials with auth InferenceError", async () => {
    const adapter = new LegacyLanguageAdapter();
    const credential = createMockCredential({ kind: "none" });

    const target: InferenceTarget = {
      providerAccount: "openai-acc",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential,
    };

    await expect(
      adapter.chat(target, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    ).rejects.toThrow(InferenceError);
  });

  it("LegacyLanguageAdapter reports stopReason: 'end_turn' for pure text streams", async () => {
    const adapter = new LegacyLanguageAdapter();
    let released = false;
    const credential = createMockCredential({ kind: "api_key", key: "sk-test" }, () => {
      released = true;
    });

    vi.spyOn(OpenAIProvider.prototype, "chatStream").mockImplementation(async function* () {
      yield { type: "text_delta", content: "hello world" };
      yield {
        type: "finish",
        usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4, cost: 0 },
      };
    });

    const target: InferenceTarget = {
      providerAccount: "openai-acc",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential,
    };

    const stream = adapter.chatStream(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const finishEvent = events.find((e) => e.type === "finish");
    expect(finishEvent).toBeDefined();
    expect((finishEvent as any).stopReason).toBe("end_turn");
    expect(released).toBe(true);
    expect(credential.activeLeaseCount).toBe(0);
  });

  it("LegacyLanguageAdapter reports stopReason: 'tool_use' and emits block start/stop for tool streams", async () => {
    const adapter = new LegacyLanguageAdapter();
    let released = false;
    const credential = createMockCredential({ kind: "api_key", key: "sk-test" }, () => {
      released = true;
    });

    vi.spyOn(OpenAIProvider.prototype, "chatStream").mockImplementation(async function* () {
      yield { type: "tool_call_begin", index: 0, id: "call-1", name: "read_file" };
      yield { type: "tool_call_delta", index: 0, argumentsDelta: '{"path":"/a.txt"}' };
      yield {
        type: "finish",
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
      };
    });

    const target: InferenceTarget = {
      providerAccount: "openai-acc",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential,
    };

    const stream = adapter.chatStream(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "check file" }] }],
    });

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const blockStart = events.find((e) => e.type === "content_block_start");
    const blockStop = events.find((e) => e.type === "content_block_stop");
    const finishEvent = events.find((e) => e.type === "finish");

    expect(blockStart).toBeDefined();
    expect((blockStart as any).block.type).toBe("tool_use");
    expect(blockStop).toBeDefined();
    expect(finishEvent).toBeDefined();
    expect((finishEvent as any).stopReason).toBe("tool_use");
    expect(released).toBe(true);
  });

  it("LegacyLanguageAdapter emits error stream event on stream failure", async () => {
    const adapter = new LegacyLanguageAdapter();
    const credential = createMockCredential({ kind: "api_key", key: "sk-test" });

    vi.spyOn(OpenAIProvider.prototype, "chatStream").mockImplementation(async function* () {
      throw new Error("Network connection dropped");
    });

    const target: InferenceTarget = {
      providerAccount: "openai-acc",
      upstreamProvider: "openai",
      model: "gpt-4o",
      credential,
    };

    const stream = adapter.chatStream(target, {
      messages: [{ role: "user", content: [{ type: "text", text: "stream fail" }] }],
    });

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as any).error.message).toContain("Network connection dropped");
  });

  it("LegacyMediaAdapter parses file paths and reads generated files as base64", async () => {
    const adapter = new LegacyMediaAdapter();
    let released = false;
    const credential = createMockCredential({ kind: "api_key", key: "sk-test" }, () => {
      released = true;
    });

    const tmpFile1 = path.join(os.tmpdir(), `test-img-${Date.now()}-1.png`);
    const tmpFile2 = path.join(os.tmpdir(), `test-img-${Date.now()}-2.png`);
    fs.writeFileSync(tmpFile1, Buffer.from("fake-png-data-1"));
    fs.writeFileSync(tmpFile2, Buffer.from("fake-png-data-2"));

    vi.spyOn(mediaModule, "generateImagesStructured").mockResolvedValue({
      success: true,
      files: [tmpFile1, tmpFile2],
    });

    const target: InferenceTarget = {
      providerAccount: "openai-acc",
      upstreamProvider: "openai",
      model: "dall-e-3",
      credential,
    };

    const result = await adapter.generate(target, {
      prompt: "Two landscape photos",
      operation: "generate",
      count: 2,
      qualityPreset: "hd",
    });

    expect(result.images.length).toBe(2);
    expect(result.images[0].base64).toBe(Buffer.from("fake-png-data-1").toString("base64"));
    expect(result.images[1].base64).toBe(Buffer.from("fake-png-data-2").toString("base64"));
    expect(result.images[0].mimeType).toBe("image/png");
    expect(released).toBe(true);
    expect(credential.activeLeaseCount).toBe(0);

    try {
      fs.unlinkSync(tmpFile1);
      fs.unlinkSync(tmpFile2);
    } catch {}
  });

  it("LegacyMediaAdapter maps structured errors and releases lease on failure", async () => {
    const adapter = new LegacyMediaAdapter();
    let released = false;
    const credential = createMockCredential({ kind: "api_key", key: "sk-test" }, () => {
      released = true;
    });

    vi.spyOn(mediaModule, "generateImagesStructured").mockResolvedValue({
      success: false,
      files: [],
      error: "Error: Invalid prompt format",
    });

    const target: InferenceTarget = {
      providerAccount: "openai-acc",
      upstreamProvider: "openai",
      model: "dall-e-3",
      credential,
    };

    await expect(
      adapter.generate(target, {
        prompt: "Invalid prompt",
        operation: "generate",
      }),
    ).rejects.toThrow(InferenceError);

    expect(released).toBe(true);
    expect(credential.activeLeaseCount).toBe(0);
  });
});
