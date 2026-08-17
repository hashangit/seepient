import { describe, it, expect } from "vitest";
import { generateImagesStructured, optimizePrompt } from "../../../capabilities/media/media.js";
import { ProviderRuntime } from "../provider-runtime.js";
import { MemoryCredentialStore } from "../credentials/memory-credential-store.js";
import { ProviderConfigStore } from "../config-store/provider-config-store.js";
import { AggregateInferenceAdapter } from "../../../capabilities/inference/aggregate-adapter.js";
import type { ImageBackend, LanguageBackend } from "../../../foundations/contracts/backend-ports.js";

describe("Media Execution via ProviderRuntime (QS-P5.3a & QS-P5.3b)", () => {
  it("executes generateImagesStructured through ProviderRuntime.executeImage", async () => {
    let capturedReq: any;
    const mockImageBackend: ImageBackend = {
      generate: async (_target, req) => {
        capturedReq = req;
        return {
          images: [
            {
              base64: Buffer.from("fake-png-content").toString("base64"),
              mimeType: "image/png",
            },
          ],
        };
      },
    };

    const adapter = new AggregateInferenceAdapter({
      openaiImage: mockImageBackend,
    });

    const credStore = new MemoryCredentialStore();
    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay({
      providers: {
        "openai-img": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "none" },
        },
      },
      modelAssignments: {
        "image-generation": {
          providerAccount: "openai-img",
          model: "gpt-image-2",
        },
      },
    }, 0);

    const runtime = new ProviderRuntime({
      configStore,
      credentialStore: credStore,
      adapter,
    });

    const res = await generateImagesStructured(
      {
        prompt: "A beautiful mountain",
        n: 1,
        size: "1536x1024",
        quality: "hd",
      },
      {
        runtime,
      },
    );

    expect(res.success).toBe(true);
    expect(res.files.length).toBe(1);
    expect(capturedReq.prompt).toBe("A beautiful mountain");
    expect(capturedReq.aspectRatio).toBe("16:9");
    expect(capturedReq.qualityPreset).toBe("high");
  });

  it("executes optimizePrompt through ProviderRuntime.executeLanguage on text.efficient", async () => {
    let capturedReq: any;
    const mockLanguageBackend: LanguageBackend = {
      chatStream: async function* (_target, req) {
        capturedReq = req;
        yield {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Act as a senior engineer and optimize the prompt.",
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
        "openai-text": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "none" },
        },
      },
      modelAssignments: {
        text: {
          efficient: {
            providerAccount: "openai-text",
            model: "gpt-4o-mini",
          },
        },
      },
    }, 0);

    const runtime = new ProviderRuntime({
      configStore,
      credentialStore: credStore,
      adapter,
    });

    const optimized = await optimizePrompt("Write a story", "Creative writing", {
      runtime,
    });

    expect(optimized).toBe("Act as a senior engineer and optimize the prompt.");
    expect(capturedReq.messages.length).toBe(2);
  });
});
