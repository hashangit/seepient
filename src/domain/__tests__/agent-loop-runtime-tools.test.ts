import { describe, it, expect, vi } from "vitest";
import { runAgentLoop } from "../agent-loop.js";
import { ProviderRuntime } from "../providers/provider-runtime.js";
import { ProviderConfigStore } from "../providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../providers/credentials/memory-credential-store.js";
import { createHookExecutor } from "../hooks.js";
import { ImageTool } from "../../capabilities/tools/image.js";

describe("Agent Loop Runtime Tool Injection & Propagation", () => {
  it("ImageTool routes through runtime executeImage when runtime is provided", async () => {
    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay(
      {
        providers: {
          openai: {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            credential: { kind: "none" },
          },
        },
        modelAssignments: {
          text: {
            standard: { providerAccount: "openai", model: "gpt-4o" },
          },
          "image-generation": {
            standard: { providerAccount: "openai", model: "dall-e-3" },
          },
        },
      },
      0,
    );

    let executeImageCalled = false;
    const runtime = new ProviderRuntime({
      configStore,
      credentialStore: new MemoryCredentialStore(),
      adapter: {
        id: "mock-adapter",
        async bind() {
          return {
            images: {
              async generate() {
                executeImageCalled = true;
                return {
                  images: [
                    {
                      mimeType: "image/png",
                      bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                      format: "png",
                      aspectRatio: "1:1",
                    },
                  ],
                  cost: 0.04,
                };
              },
            },
          } as any;
        },
      },
    });

    const output = await ImageTool.handler(
      { prompt: "A glowing galaxy" },
      { runtime },
    );

    expect(executeImageCalled).toBe(true);
    expect(output).toContain("Successfully generated 1 image");
  });

  it("propagates runtime errors without silently falling back", async () => {
    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay(
      {
        providers: {
          openai: {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            credential: { kind: "none" },
          },
        },
        modelAssignments: {
          text: {
            standard: { providerAccount: "openai", model: "gpt-4o" },
          },
        },
      },
      0,
    );

    const runtime = new ProviderRuntime({
      configStore,
      credentialStore: new MemoryCredentialStore(),
      adapter: {
        id: "failing-adapter",
        async bind() {
          return {
            language: {
              async *stream() {
                yield {
                  type: "error",
                  error: {
                    code: "unconfigured_purpose",
                    message: "No model assignment configured for purpose",
                    retryable: false,
                  },
                };
              },
            },
          } as any;
        },
      },
    });

    const snapshot = await runtime.createTurnSnapshot();
    const result = await runAgentLoop({
      runtime,
      model: "gpt-4o",
      messages: [{ id: "m1", role: "user", content: "hello", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 1,
      hooks: createHookExecutor(),
      turnSnapshot: snapshot,
    });

    expect(result.finishReason).toBe("error");
    expect(result.error?.message).toContain("No model assignment configured for purpose");
  });

  it("preserves finishReason aborted when abort event fires", async () => {
    const configStore = new ProviderConfigStore(":memory:");
    await configStore.updateOverlay(
      {
        providers: {
          openai: {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            credential: { kind: "none" },
          },
        },
        modelAssignments: {
          text: {
            standard: { providerAccount: "openai", model: "gpt-4o" },
          },
        },
      },
      0,
    );

    const runtime = new ProviderRuntime({
      configStore,
      credentialStore: new MemoryCredentialStore(),
      adapter: {
        id: "abort-adapter",
        async bind() {
          return {
            language: {
              async *stream() {
                yield {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Partial..." },
                };
                yield {
                  type: "abort",
                  reason: "user",
                };
              },
            },
          } as any;
        },
      },
    });

    const snapshot = await runtime.createTurnSnapshot();
    const result = await runAgentLoop({
      runtime,
      model: "gpt-4o",
      messages: [{ id: "m1", role: "user", content: "hello", timestamp: Date.now() }],
      toolDefs: [],
      maxSteps: 1,
      hooks: createHookExecutor(),
      turnSnapshot: snapshot,
    });

    expect(result.finishReason).toBe("aborted");
  });
});
