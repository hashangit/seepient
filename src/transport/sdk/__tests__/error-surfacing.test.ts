import { describe, it, expect, vi } from "vitest";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";
import { createSeepient, askSeepient } from "../index.js";
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

  it("askSeepient throws typed SeepientError on provider failure", async () => {
    const runtime = createFailingRuntime("RATE_LIMIT", "Too many requests");
    await expect(
      askSeepient("Hello", {
        runtime: runtime as any,
        model: "mock-model",
        tenancy: "single",
      }),
    ).rejects.toThrowError(SeepientError);

    try {
      await askSeepient("Hello", {
        runtime: runtime as any,
        model: "mock-model",
        tenancy: "single",
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
    const agent = await createSeepient({
      runtime: runtime as any,
      model: "mock-model",
      tenancy: "single",
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

  it("askSeepient with stream: true invokes onError and finishes with error on provider failure", async () => {
    const runtime = createFailingRuntime("QUOTA_EXCEEDED", "Account quota depleted");
    const onError = vi.fn();

    const stream = await askSeepient("Hello", { stream: true,
      runtime: runtime as any,
      model: "mock-model",
      onError,
      tenancy: "single",
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
    const agent = await createSeepient({
      runtime: runtime as any,
      model: "mock-model",
      tenancy: "single",
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

  it("chatStream surfaces loop errors through middleware (error must survive the pipeline copy)", async () => {
    const runtime = createFailingRuntime("AUTH_FAILURE", "Invalid API key");
    // Middleware must be passed at creation level: instance methods thread
    // opts.middleware into runAgentLoop; per-call middleware on chatStream is
    // not read, and a per-call pin would pass vacuously off the bare loop.
    const agent = await createSeepient({
      runtime: runtime as any,
      model: "mock-model",
      tenancy: "single",
      middleware: [async (_ctx, next) => { await next(); }],
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
    const stream = await askSeepient("Hello", { stream: true,
      runtime: runtime as any,
      model: "mock-model",
      signal: controller.signal,
      onError,
      tenancy: "single",
    });

    const finish = await stream.finishReason;
    expect(finish).toBe("aborted");
    expect(onError).not.toHaveBeenCalled();
  });
});

// v0.9.0 release-gate r1: the consumer's onError is an untrusted boundary.
// Pre-fix, a throwing callback re-entered the error path (double dispatch),
// skipped the stream settles (finishReason/fullText hung forever), escaped
// the fire-and-forget turn IIFE as an unhandledRejection, and — on the
// non-streaming path — skipped the signal-bridge detach.
describe("Throwing consumer callbacks (gate r1)", () => {
  function createFailingRuntime(errorCode = "AUTH_FAILURE", errorMessage = "Invalid API key") {
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
          error: { code: errorCode, message: errorMessage, retryable: false },
        };
      },
    };
  }

  function trackRejections() {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    return {
      rejections,
      stop: () => process.off("unhandledRejection", onRejection),
    };
  }

  it("chatStream: a throwing onError dispatches once, settles the stream, raises no unhandledRejection", async () => {
    const runtime = createFailingRuntime();
    const agent = await createSeepient({
      runtime: runtime as any,
      model: "mock-model",
      tenancy: "single",
    });
    const tracked = trackRejections();
    let calls = 0;
    try {
      const stream = await agent.chatStream("Hello", {
        onError() {
          calls += 1;
          throw new Error("consumer sink down");
        },
      });

      const finish = await stream.finishReason;
      expect(finish).toBe("error");
      await expect(stream.fullText).rejects.toThrowError(/Invalid API key/);
      await new Promise((r) => setTimeout(r, 10)); // let fire-and-forget tails flush
      expect(calls).toBe(1);
      expect(tracked.rejections).toEqual([]);
    } finally {
      tracked.stop();
    }
  });

  it("askSeepient streaming: a throwing onError dispatches once and settles", async () => {
    const runtime = createFailingRuntime();
    const tracked = trackRejections();
    let calls = 0;
    try {
      const stream = await askSeepient("Hello", {
        stream: true,
        runtime: runtime as any,
        model: "mock-model",
        tenancy: "single",
        onError() {
          calls += 1;
          throw new Error("consumer sink down");
        },
      });

      const finish = await stream.finishReason;
      expect(finish).toBe("error");
      await expect(stream.fullText).rejects.toThrowError(/Invalid API key/);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(1);
      expect(tracked.rejections).toEqual([]);
    } finally {
      tracked.stop();
    }
  });

  it("askSeepient non-streaming: a throwing onError does not replace the loop error", async () => {
    const runtime = createFailingRuntime();
    let calls = 0;
    await expect(
      askSeepient("Hello", {
        runtime: runtime as any,
        model: "mock-model",
        tenancy: "single",
        onError() {
          calls += 1;
          throw new Error("consumer sink down");
        },
      }),
    ).rejects.toThrowError(/Invalid API key/);
    expect(calls).toBe(1);
  });

  it("askSeepient non-streaming: a throwing call still detaches the caller-signal bridge", async () => {
    const runtime = {
      createTurnSnapshot: async () => {
        throw new Error("snapshot exploded");
      },
    };
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    await expect(
      askSeepient("Hello", {
        runtime: runtime as any,
        model: "mock-model",
        tenancy: "single",
        signal: controller.signal,
      }),
    ).rejects.toThrowError(/snapshot exploded/);
    expect(removeSpy).toHaveBeenCalled();
  });

  it("askSeepient non-streaming: a THROWING SETUP also detaches the caller-signal bridge (gate r2 P2-E)", async () => {
    // An unknown tool name throws in resolveTools — inside the setup window,
    // before the dispatch-path finallys. Pre-fix it leaked the bridge listener.
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    await expect(
      askSeepient("Hello", {
        runtime: createFailingRuntime() as any,
        model: "mock-model",
        tenancy: "single",
        signal: controller.signal,
        tools: ["definitely_not_a_real_tool_xyz"],
      }),
    ).rejects.toThrowError(/definitely_not_a_real_tool_xyz/);
    expect(removeSpy).toHaveBeenCalled();
  });

  it("an ASYNC-REJECTING onError also stays contained (gate r2 P2-D)", async () => {
    const runtime = createFailingRuntime();
    const agent = await createSeepient({
      runtime: runtime as any,
      model: "mock-model",
      tenancy: "single",
    });
    const tracked = trackRejections();
    let calls = 0;
    try {
      const stream = await agent.chatStream("Hello", {
        onError: async () => {
          calls += 1;
          throw new Error("async sink down");
        },
      });

      const finish = await stream.finishReason;
      expect(finish).toBe("error");
      await expect(stream.fullText).rejects.toThrowError(/Invalid API key/);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(1);
      expect(tracked.rejections).toEqual([]);
    } finally {
      tracked.stop();
    }
  });

  // Gate r3 P1-1: the caller-signal bridge must live until the streaming
  // turn settles — the r2 outer finally detached it at RETURN-time, so a
  // caller abort after `askSeepient` returned could no longer cancel the
  // in-flight turn (it kept running to maxSteps). Red on the r2 tree: the
  // finishReason promise never settles.
  it("streaming askSeepient: aborting the CALLER signal mid-stream settles the stream (gate r3 P1-1)", async () => {
    const hangingRuntime = {
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
      executeLanguage: async function* (
        _plan: unknown,
        _payload: unknown,
        opts: { signal?: AbortSignal },
      ) {
        yield { type: "start", resolvedModel: { providerAccount: "mock", modelId: "mock-model" } };
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) resolve();
          else opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "abort", reason: "user" };
      },
    };

    const controller = new AbortController();
    const stream = await askSeepient("Hello", {
      stream: true,
      runtime: hangingRuntime as any,
      model: "mock-model",
      tenancy: "single",
      signal: controller.signal,
    });

    await new Promise((r) => setTimeout(r, 50)); // let the loop park in the hanging generator
    controller.abort();

    const finish = await stream.finishReason;
    expect(finish).toBe("aborted");
  });
});
