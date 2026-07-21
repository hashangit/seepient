import { describe, it, expect, vi } from "vitest";
import { createHookExecutor } from "../hooks.js";
import { SeepientError } from "../../foundations/errors.js";
import type { Hooks, StepResult, GenerateTextResult } from "../../foundations/types.js";

function makeStep(): StepResult {
  return { type: "text", content: "hi", timestamp: Date.now() };
}

function makeResult(): GenerateTextResult {
  return {
    text: "done",
    steps: [],
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
    finishReason: "stop",
    messages: [],
  };
}

describe("createHookExecutor", () => {
  it("calls beforeToolCall hook", async () => {
    const beforeToolCall = vi.fn();
    const executor = createHookExecutor({ beforeToolCall } as Hooks);
    await executor.beforeToolCall({ name: "read_file", args: { path: "/x" } });
    expect(beforeToolCall).toHaveBeenCalledWith({ name: "read_file", args: { path: "/x" } });
  });

  it("calls afterToolCall hook", async () => {
    const afterToolCall = vi.fn();
    const executor = createHookExecutor({ afterToolCall } as Hooks);
    await executor.afterToolCall({ name: "read_file", output: "ok", duration: 50 });
    expect(afterToolCall).toHaveBeenCalledWith({ name: "read_file", output: "ok", duration: 50 });
  });

  it("calls onStep hook", async () => {
    const onStep = vi.fn();
    const executor = createHookExecutor({ onStep } as Hooks);
    const step = makeStep();
    await executor.onStep(step);
    expect(onStep).toHaveBeenCalledWith(step);
  });

  it("calls onError hook", async () => {
    const onError = vi.fn();
    const executor = createHookExecutor({ onError } as Hooks);
    const err = new SeepientError("boom", "TEST");
    await executor.onError(err);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it("calls onFinish hook", async () => {
    const onFinish = vi.fn();
    const executor = createHookExecutor({ onFinish } as Hooks);
    const result = makeResult();
    await executor.onFinish(result);
    expect(onFinish).toHaveBeenCalledWith(result);
  });

  it("treats missing hooks as no-ops", async () => {
    const executor = createHookExecutor(undefined);
    // Should not throw
    await executor.beforeToolCall({ name: "x", args: {} });
    await executor.afterToolCall({ name: "x", output: "", duration: 0 });
    await executor.onStep(makeStep());
    await executor.onError(new SeepientError("x", "CODE"));
    await executor.onFinish(makeResult());
  });

  it("swallows errors from hooks (does not rethrow)", async () => {
    const badHook = vi.fn().mockImplementation(() => {
      throw new Error("hook exploded");
    });
    const executor = createHookExecutor({ beforeToolCall: badHook } as Hooks);
    // Should not throw
    await executor.beforeToolCall({ name: "x", args: {} });
    expect(badHook).toHaveBeenCalled();
  });

  it("awaits async hooks", async () => {
    let resolved = false;
    const asyncHook = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      resolved = true;
    });
    const executor = createHookExecutor({ onStep: asyncHook } as Hooks);
    await executor.onStep(makeStep());
    expect(resolved).toBe(true);
  });
});
