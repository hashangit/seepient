import { describe, it, expect, vi, beforeEach } from "vitest";
import { serverGenerateText, serverStreamText } from "../server-core.js";
import { createMockRuntime } from "../../../domain/__tests__/test-doubles.js";

describe("server model-override handling (QS-P0.1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes explicit model override to runtime in serverGenerateText", async () => {
    let receivedPlan: any = null;
    const runtime = createMockRuntime([
      {
        text: "Response generated from gpt-5.4-mini",
      },
    ]);
    const origResolvePlan = runtime.resolvePlan.bind(runtime);
    runtime.resolvePlan = async (...args) => {
      const plan = await origResolvePlan(...args);
      receivedPlan = plan;
      return plan;
    };

    const result = await serverGenerateText(
      {
        message: "Hello",
        provider: "openai",
        model: "gpt-5.4-mini",
        providerRuntime: runtime,
      } as any,
    );

    expect(receivedPlan?.selectedTarget?.model).toBe("gpt-5.4-mini");
    expect(result.text).toBe("Response generated from gpt-5.4-mini");
  });

  it("passes explicit model override to runtime in serverStreamText", async () => {
    let receivedPlan: any = null;
    const runtime = createMockRuntime([
      {
        text: "Streaming from gpt-5.4-mini",
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
      },
    ]);
    const origResolvePlan = runtime.resolvePlan.bind(runtime);
    runtime.resolvePlan = async (...args) => {
      const plan = await origResolvePlan(...args);
      receivedPlan = plan;
      return plan;
    };

    const textDeltas: string[] = [];
    let doneResult: any = null;

    await serverStreamText(
      {
        message: "Hello",
        provider: "openai",
        model: "gpt-5.4-mini",
        providerRuntime: runtime,
        onText: (delta: string) => textDeltas.push(delta),
        onToolCall: () => {},
        onToolResult: () => {},
        onStep: () => {},
        onError: () => {},
        onDone: (res: any) => {
          doneResult = res;
        },
      } as any,
    );

    expect(receivedPlan?.selectedTarget?.model).toBe("gpt-5.4-mini");
    expect(textDeltas.join("")).toBe("Streaming from gpt-5.4-mini");
    expect(doneResult?.finishReason).toBe("stop");
  });
});
