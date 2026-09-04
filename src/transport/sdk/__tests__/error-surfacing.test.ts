import { describe, it, expect, vi } from "vitest";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";
import { createAgent, generateText, streamText } from "../index.js";
import { serverStreamText } from "../../http/server-core.js";
import { SeepientError } from "../../../foundations/errors.js";

describe("Centralized Loop Error Surfacing (Task 1.2)", () => {
  function createFailingRuntime(errorCode = "PROVIDER_ERROR", errorMessage = "API rate limit exceeded") {
    return {
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
          error: { code: errorCode, message: errorMessage, retryable: true },
        };
      },
    };
  }

  it("generateText throws typed SeepientError on provider failure", async () => {
    const runtime = createFailingRuntime("RATE_LIMIT", "Too many requests");
    await expect(
      generateText("Hello", {
        runtime: runtime as any,
        model: "mock-model",
      }),
    ).rejects.toThrowError(SeepientError);

    try {
      await generateText("Hello", {
        runtime: runtime as any,
        model: "mock-model",
      });
    } catch (err: any) {
      expect(err).toBeInstanceOf(SeepientError);
      expect(err.code).toBe("RATE_LIMIT");
      expect(err.message).toBe("Too many requests");
      expect(err.retryable).toBe(true);
    }
  });

  it("chat() throws typed SeepientError on provider failure", async () => {
    const runtime = createFailingRuntime("SERVICE_UNAVAILABLE", "Model offline");
    const agent = await createAgent({
      runtime: runtime as any,
      model: "mock-model",
    });

    await expect(agent.chat("Hello")).rejects.toThrowError(SeepientError);

    try {
      await agent.chat("Hello");
    } catch (err: any) {
      expect(err).toBeInstanceOf(SeepientError);
      expect(err.code).toBe("SERVICE_UNAVAILABLE");
      expect(err.message).toBe("Model offline");
    }
  });

  it("streamText invokes onError and finishes with error on provider failure", async () => {
    const runtime = createFailingRuntime("QUOTA_EXCEEDED", "Account quota depleted");
    const onError = vi.fn();

    const stream = await streamText("Hello", {
      runtime: runtime as any,
      model: "mock-model",
      onError,
    });

    const finish = await stream.finishReason;
    expect(finish).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0];
    expect(err).toBeInstanceOf(SeepientError);
    expect(err.code).toBe("QUOTA_EXCEEDED");
    expect(err.message).toBe("Account quota depleted");
  });

  it("chatStream invokes onError and finishes with error on provider failure", async () => {
    const runtime = createFailingRuntime("AUTH_FAILURE", "Invalid API key");
    const agent = await createAgent({
      runtime: runtime as any,
      model: "mock-model",
    });

    const onError = vi.fn();
    const stream = await agent.chatStream("Hello", { onError });

    const finish = await stream.finishReason;
    expect(finish).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0];
    expect(err).toBeInstanceOf(SeepientError);
    expect(err.code).toBe("AUTH_FAILURE");
    expect(err.message).toBe("Invalid API key");
  });

  it("serverStreamText invokes onError and onDone with finishReason error on provider failure", async () => {
    const runtime = createFailingRuntime("INTERNAL_ERROR", "Server crash");
    const onError = vi.fn();
    const onDone = vi.fn();

    await serverStreamText({
      message: "Hello",
      model: "mock-model",
      runtime: runtime as any,
      onText: () => {},
      onStep: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onError,
      onDone,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        message: "Server crash",
      }),
    );
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        finishReason: "error",
      }),
    );
  });

  it("abort signals are never surfaced as errors", async () => {
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
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Starting..." },
        };
      },
    };

    const controller = new AbortController();
    controller.abort();

    const onError = vi.fn();
    const stream = await streamText("Hello", {
      runtime: runtime as any,
      model: "mock-model",
      signal: controller.signal,
      onError,
    });

    const finish = await stream.finishReason;
    expect(finish).toBe("aborted");
    expect(onError).not.toHaveBeenCalled();
  });
});
