import { describe, it, expect, vi } from "vitest";
import { askSeepient } from "../index.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";
import { SeepientError } from "../../../foundations/errors.js";

describe("askSeepient — Unified One-Shot Entry Point", () => {
  it("defaults to non-streaming and returns AskSeepientResult", async () => {
    const runtime = createMockRuntime([
      { text: "Paris is the capital of France." },
    ]);

    const result = await askSeepient("What is the capital of France?", {
      runtime: runtime as any,
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
      runtime: runtime as any,
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
        selectedTarget: { providerAccount: "mock", model: "mock-model" },
        failureTargets: [],
      }),
      executeLanguage: async function* () {
        yield {
          type: "error",
          error: { code: "RATE_LIMIT", message: "Rate limit reached", retryable: true },
        };
      },
    };

    await expect(
      askSeepient("Hello", {
        runtime: runtime as any,
        model: "mock-model",
      }),
    ).rejects.toThrow(SeepientError);
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
      runtime: runtime as any,
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
      runtime: runtime as any,
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
      runtime: runtime as any,
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

  it("handles streaming abort via stream.abort()", async () => {
    const runtime = createMockRuntime([{ text: "Will be aborted" }]);

    const stream = await askSeepient("Abort test", {
      runtime: runtime as any,
      tools: [],
      maxSteps: 1,
      stream: true,
    });

    stream.abort();
    const finish = await stream.finishReason;
    expect(["stop", "aborted"]).toContain(finish);
  });
});
