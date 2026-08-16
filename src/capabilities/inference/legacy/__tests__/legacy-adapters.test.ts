import { describe, it, expect, vi } from "vitest";
import { LegacyLanguageAdapter } from "../legacy-language-adapter.js";
import { LegacyMediaAdapter } from "../legacy-media-adapter.js";
import type { InferenceTarget } from "../../../../foundations/contracts/backend-ports.js";
import type { CredentialHandle, CredentialLease } from "../../../../foundations/contracts/credential-store.js";
import { InferenceError } from "../../../../foundations/errors.js";
import * as mediaModule from "../../../media/media.js";
import { OpenAIProvider } from "../../../llm/openai.js";

function createMockCredential(secretValue: string, onRelease?: () => void): CredentialHandle {
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
    const credential = createMockCredential("sk-test", () => {
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

  it("LegacyLanguageAdapter releases lease on chatStream completion", async () => {
    const adapter = new LegacyLanguageAdapter();
    let released = false;
    const credential = createMockCredential("sk-test", () => {
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

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(released).toBe(true);
    expect(credential.activeLeaseCount).toBe(0);
  });

  it("LegacyMediaAdapter generates image and releases lease", async () => {
    const adapter = new LegacyMediaAdapter();
    let released = false;
    const credential = createMockCredential("sk-test", () => {
      released = true;
    });

    vi.spyOn(mediaModule, "generateImages").mockResolvedValue("https://example.com/generated-image.png");

    const target: InferenceTarget = {
      providerAccount: "openai-acc",
      upstreamProvider: "openai",
      model: "dall-e-3",
      credential,
    };

    const result = await adapter.generate(target, {
      prompt: "A beautiful forest",
      operation: "generate",
      qualityPreset: "hd",
    });

    expect(result.images.length).toBe(1);
    expect(result.images[0].url).toBe("https://example.com/generated-image.png");
    expect(result.images[0].mimeType).toBe("image/png");
    expect(released).toBe(true);
    expect(credential.activeLeaseCount).toBe(0);
  });

  it("LegacyMediaAdapter maps errors and releases lease on failure", async () => {
    const adapter = new LegacyMediaAdapter();
    let released = false;
    const credential = createMockCredential("sk-test", () => {
      released = true;
    });

    vi.spyOn(mediaModule, "generateImages").mockResolvedValue("Error: Invalid prompt format");

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
