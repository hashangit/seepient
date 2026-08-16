import { describe, it, expect, vi, beforeEach } from "vitest";
import { serverGenerateText, serverStreamText } from "../server-core.js";
import * as providerConfigModule from "../../../domain/providers/provider-config.js";
import type { LLMProvider, ProviderResponse } from "../../../foundations/contracts/llm.js";

describe("server model-override handling (QS-P0.1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes explicit model override to getProvider in serverGenerateText", async () => {
    const mockProvider: LLMProvider = {
      async chat(): Promise<ProviderResponse> {
        return { content: "Response generated from gpt-5.4-mini" };
      },
    };

    const getProviderSpy = vi.spyOn(providerConfigModule, "getProvider").mockResolvedValue({
      provider: mockProvider,
      model: "gpt-5.4-mini",
    });

    const result = await serverGenerateText(
      {
        message: "Hello",
        provider: "openai",
        model: "gpt-5.4-mini",
      },
      "moderate",
    );

    expect(getProviderSpy).toHaveBeenCalledWith("openai", "gpt-5.4-mini");
    expect(result.text).toBe("Response generated from gpt-5.4-mini");
  });

  it("passes explicit model override to getProvider in serverStreamText", async () => {
    const mockProvider: LLMProvider = {
      async chat(): Promise<ProviderResponse> {
        return { content: "Streaming from gpt-5.4-mini" };
      },
      async *chatStream() {
        yield { type: "text_delta", content: "Streaming from " };
        yield { type: "text_delta", content: "gpt-5.4-mini" };
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10, cost: 0 },
        };
      },
    };

    const getProviderSpy = vi.spyOn(providerConfigModule, "getProvider").mockResolvedValue({
      provider: mockProvider,
      model: "gpt-5.4-mini",
    });

    const textDeltas: string[] = [];
    let doneResult: any = null;

    await serverStreamText(
      {
        message: "Hello",
        provider: "openai",
        model: "gpt-5.4-mini",
        onText: (delta) => textDeltas.push(delta),
        onToolCall: () => {},
        onToolResult: () => {},
        onStep: () => {},
        onError: () => {},
        onDone: (res) => {
          doneResult = res;
        },
      },
      "moderate",
    );

    expect(getProviderSpy).toHaveBeenCalledWith("openai", "gpt-5.4-mini");
    expect(textDeltas.join("")).toBe("Streaming from gpt-5.4-mini");
    expect(doneResult?.finishReason).toBe("stop");
  });
});
