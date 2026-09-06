import { describe, it, expect, vi } from "vitest";
import { askSeepient } from "../index.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";
import { SeepientError } from "../../../foundations/errors.js";
import type { ProviderRuntimeContract } from "../../../foundations/contracts/provider-runtime.js";

// W110: capture every AbortSignal handed to media vendor operation handlers
// (both the SDK-boundary handler and the agent-loop handler) so tests can
// assert that abort actually reaches media operations.
const mediaHandlerState = vi.hoisted(() => ({
  signals: [] as (AbortSignal | undefined)[],
}));

vi.mock("../../../domain/media/vendor-operation-handler.js", () => ({
  createMediaVendorOperationHandler: (opts: { signal?: AbortSignal }) => {
    mediaHandlerState.signals.push(opts.signal);
    return async (req: { requestId: string }) => ({
      requestId: req.requestId,
      status: "failed" as const,
      error: { code: "SETUP_REQUIRED", message: "mock media handler", retryable: false },
    });
  },
}));

/**
 * A runtime whose model stream starts and then hangs until the loop's abort
 * signal fires — makes streaming-abort outcomes deterministic ("aborted",
 * never a race against a completing mock).
 */
function createHangingRuntime(): ProviderRuntimeContract {
  return {
    createTurnSnapshot: async () => ({
      revision: 1,
      createdAt: new Date().toISOString(),
      catalog: [],
      config: {} as any,
      assignments: {} as any,
    }),
    resolvePlan: async () => ({
      selectedTarget: {
        providerAccount: "mock-account",
        upstreamProvider: "mock",
        model: "mock-model",
        credential: { id: "mock" } as any,
      },
      failureTargets: [],
    }),
    executeLanguage: async function* (_plan, _payload, opts) {
      yield { type: "start", resolvedModel: { providerAccount: "mock-account", modelId: "mock-model" } };
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) resolve();
        else opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "abort", reason: "user" };
    },
  };
}

describe("askSeepient — Unified One-Shot Entry Point", () => {
  it("defaults to non-streaming and returns AskSeepientResult", async () => {
    const runtime = createMockRuntime([
      { text: "Paris is the capital of France." },
    ]);

    const result = await askSeepient("What is the capital of France?", {
      runtime,
      tools: [],
      maxSteps: 1,
    });

    expect(result.text).toBe("Paris is the capital of France.");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.totalTokens).toBeGreaterThanOrEqual(0);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.steps).toBeDefined();
    expect(result.toolCalls).toBeDefined();
  });

  it("fires hooks.onFinish with AskSeepientResult on completion", async () => {
    const runtime = createMockRuntime([{ text: "Done!" }]);
    const onFinish = vi.fn();

    const result = await askSeepient("Do work", {
      runtime,
      tools: [],
      maxSteps: 1,
      hooks: { onFinish },
    });

    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith(result);
    expect(result.text).toBe("Done!");
  });

  it("throws typed SeepientError in non-streaming mode on provider error", async () => {
    const runtime = {
      createTurnSnapshot: async () => ({
        revision: 1,
        createdAt: new Date().toISOString(),
        catalog: [],
        config: {} as any,
        assignments: {} as any,
      }),
      resolvePlan: async () => ({
        selectedTarget: { providerAccount: "mock", model: "mock-model" } as any,
        failureTargets: [],
      }),
      executeLanguage: async function* (): AsyncGenerator<import("../../../foundations/schemas/inference.js").StreamEvent> {
        yield {
          type: "error",
          error: { code: "RATE_LIMIT", message: "Rate limit reached", retryable: true },
        };
      },
    };

    await expect(
      askSeepient("Hello", {
        runtime,
        model: "mock-model",
      }),
    ).rejects.toThrow(SeepientError);
  });

  // W111: onError parity between streaming and non-streaming modes.
  it("invokes opts.onError AND rejects in non-streaming mode on provider error", async () => {
    const runtime = {
      createTurnSnapshot: async () => ({
        revision: 1,
        createdAt: new Date().toISOString(),
        catalog: [],
        config: {} as any,
        assignments: {} as any,
      }),
      resolvePlan: async () => ({
        selectedTarget: { providerAccount: "mock", model: "mock-model" } as any,
        failureTargets: [],
      }),
      executeLanguage: async function* (): AsyncGenerator<import("../../../foundations/schemas/inference.js").StreamEvent> {
        yield {
          type: "error",
          error: { code: "RATE_LIMIT", message: "Rate limit reached", retryable: true },
        };
      },
    };
    const onError = vi.fn();

    const promise = askSeepient("Hello", {
      runtime,
      model: "mock-model",
      onError,
    });

    await expect(promise).rejects.toThrow(SeepientError);
    expect(onError).toHaveBeenCalledTimes(1);
    const reported = onError.mock.calls[0][0];
    expect(reported).toBeInstanceOf(SeepientError);
    expect(reported.code).toBe("RATE_LIMIT");
  });

  // F2: a failed streaming turn must be observable — fullText rejects (the
  // non-streaming path throws), even when the caller has no onError callback.
  it("streaming fullText rejects on provider error instead of resolving empty", async () => {
    const runtime = {
      createTurnSnapshot: async () => ({
        revision: 1,
        createdAt: new Date().toISOString(),
        catalog: [],
        config: {} as any,
        assignments: {} as any,
      }),
      resolvePlan: async () => ({
        selectedTarget: { providerAccount: "mock", model: "mock-model" } as any,
        failureTargets: [],
      }),
      executeLanguage: async function* (): AsyncGenerator<import("../../../foundations/schemas/inference.js").StreamEvent> {
        throw new Error("invalid api key");
      },
    };

    const onError = vi.fn();
    const stream = await askSeepient("Hello", {
      runtime,
      model: "mock-model",
      stream: true,
      onError,
    });

    await expect(stream.fullText).rejects.toThrow(/invalid api key/);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(await stream.finishReason).toBe("error");
    // textStream completes without throwing for delta-only consumers
    const chunks: string[] = [];
    for await (const chunk of stream.textStream) chunks.push(chunk);
    expect(chunks).toEqual([]);
  });

  // W112: hooks.onFinish parity — streaming callers get it too.
  it("fires hooks.onFinish with the assembled result in streaming mode", async () => {
    const runtime = createMockRuntime([
      {
        text: "Streamed finish",
        usage: { promptTokens: 3, completionTokens: 3, totalTokens: 6, cost: 0 },
      },
    ]);
    const onFinish = vi.fn();

    const stream = await askSeepient("Stream with hooks", {
      runtime,
      tools: [],
      maxSteps: 1,
      stream: true,
      hooks: { onFinish },
    });

    for await (const _chunk of stream.textStream) {
      // drain
    }
    expect(await stream.finishReason).toBe("stop");
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));

    const assembled = onFinish.mock.calls[0][0];
    expect(assembled.text).toBe("Streamed finish");
    expect(assembled.finishReason).toBe("stop");
    expect(assembled.usage.totalTokens).toBe(6);
    expect(Array.isArray(assembled.messages)).toBe(true);
  });

  it("returns AskSeepientStreamResult when stream: true", async () => {
    const runtime = createMockRuntime([
      {
        text: "Streaming answer",
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
      },
    ]);

    const onText = vi.fn();
    const stream = await askSeepient("Tell me a story", {
      runtime,
      tools: [],
      maxSteps: 1,
      stream: true,
      onText,
    });

    expect(typeof stream.abort).toBe("function");
    expect(typeof stream.toResponse).toBe("function");
    expect(typeof stream.toSSEStream).toBe("function");

    const chunks: string[] = [];
    for await (const chunk of stream.textStream) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("Streaming answer");
    expect(await stream.fullText).toBe("Streaming answer");
    expect(await stream.finishReason).toBe("stop");
    const usage = await stream.usage;
    expect(usage.totalTokens).toBe(10);
  });

  it("supports toResponse() with optional custom headers", async () => {
    const runtime = createMockRuntime([{ text: "SSE payload" }]);

    const stream = await askSeepient("SSE test", {
      runtime,
      tools: [],
      maxSteps: 1,
      stream: true,
    });

    const response = stream.toResponse({
      headers: {
        "X-Custom-Header": "custom-value",
      },
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-custom-header")).toBe("custom-value");

    const text = await response.text();
    expect(text).toContain("event: text");
    expect(text).toContain("SSE payload");
    expect(text).toContain("event: done");
  });

  it("supports toSSEStream() for ReadableStream consumers", async () => {
    const runtime = createMockRuntime([{ text: "Streamed via SSE" }]);

    const stream = await askSeepient("SSE stream test", {
      runtime,
      tools: [],
      maxSteps: 1,
      stream: true,
    });

    const sseStream = stream.toSSEStream();
    expect(sseStream).toBeInstanceOf(ReadableStream);

    const reader = sseStream.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value);
    }

    expect(accumulated).toContain("event: text");
    expect(accumulated).toContain("Streamed via SSE");
    expect(accumulated).toContain("event: done");
  });

  // W110/W117: deterministic streaming abort — the loop hangs until aborted,
  // so "aborted" is the only possible finish, and the abort must reach the
  // media vendor operation handlers (which used to keep running while the
  // loop stopped).
  it("stream.abort() stops the loop and aborts media operation handlers", async () => {
    mediaHandlerState.signals.length = 0;

    const stream = await askSeepient("Abort test", {
      runtime: createHangingRuntime(),
      tools: [],
      maxSteps: 1,
      stream: true,
    });

    stream.abort();
    expect(await stream.finishReason).toBe("aborted");

    expect(mediaHandlerState.signals.length).toBeGreaterThan(0);
    for (const signal of mediaHandlerState.signals) {
      expect(signal?.aborted).toBe(true);
    }
  });

  // W110: a caller-supplied opts.signal must still reach BOTH the loop and
  // the media vendor operation handlers through the bridged controller.
  it("bridges opts.signal to the agent loop and media handlers (non-streaming)", async () => {
    mediaHandlerState.signals.length = 0;
    const external = new AbortController();
    const runtime = createHangingRuntime();

    const resultPromise = askSeepient("External abort", {
      runtime,
      tools: [],
      maxSteps: 1,
      signal: external.signal,
    });

    // The handlers are wired asynchronously before askSeepient resolves.
    await vi.waitFor(() => expect(mediaHandlerState.signals.length).toBeGreaterThan(0));

    external.abort();
    const result = await resultPromise;
    expect(result.finishReason).toBe("aborted");
    for (const signal of mediaHandlerState.signals) {
      expect(signal?.aborted).toBe(true);
    }
  });
});
