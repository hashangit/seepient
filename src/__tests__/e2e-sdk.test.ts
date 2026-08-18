import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRuntime } from "../domain/__tests__/test-doubles.js";
import { generateText, createAgent } from "../transport/sdk/index.js";

describe("SDK e2e — generateText with mock runtime", () => {
  it("runs generateText end-to-end", async () => {
    const runtime = createMockRuntime([
      {
        text: "Hello from Seepient!",
      },
    ]);

    const result = await generateText("Say hello", {
      tools: [],
      maxSteps: 1,
      runtime,
    } as any);

    expect(result.text).toBe("Hello from Seepient!");
    expect(result.finishReason).toBe("stop");
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("fires hooks through the loop", async () => {
    const runtime = createMockRuntime([
      {
        text: "Hello from Seepient!",
      },
    ]);

    const onStep = vi.fn();
    const onError = vi.fn();
    const onFinish = vi.fn();

    await generateText("Ping", {
      tools: [],
      maxSteps: 1,
      runtime,
      hooks: { onStep, onError, onFinish },
    } as any);

    expect(onStep).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalled();
  });

  it("passes system prompt to the provider", async () => {
    const runtime = createMockRuntime([
      {
        text: "System acknowledged",
      },
    ]);

    const result = await generateText("Hello", {
      tools: [],
      maxSteps: 1,
      runtime,
      systemPrompt: "You are a test assistant.",
    } as any);

    const systemMsg = result.messages.find((m: any) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.content).toContain("You are a test assistant.");
  });
});

describe("SDK e2e — chatStream with a streaming runtime", () => {
  it("streams text deltas through textStream + fullText", async () => {
    const runtime = createMockRuntime([
      {
        text: "Hello",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0 },
      },
    ]);

    const agent = await createAgent({ runtime, tools: [], maxSteps: 1 } as any);

    const result = await agent.chatStream("hi");
    const chunks: string[] = [];
    for await (const chunk of result.textStream) chunks.push(chunk);

    expect(chunks.join("")).toBe("Hello");
    expect(await result.fullText).toBe("Hello");
    expect(await result.finishReason).toBe("stop");
  });
});
