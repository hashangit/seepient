import { describe, it, expect } from "vitest";
import { PiLanguageRaw } from "../pi-language-raw.js";
import { PiImageRaw } from "../pi-image-raw.js";
import { OpenAIImageRaw } from "../../openai/openai-image-raw.js";
import { GoogleImageRaw } from "../../google/google-image-raw.js";
import { canonicalToPiContext } from "../pi-canonical-converter.js";
import { classifyInferenceError } from "../../../foundations/errors/error-classifier.js";
import { InferenceError } from "../../../foundations/errors.js";
import type { InferenceTarget, LanguageRequest } from "../../../foundations/contracts/backend-ports.js";
import type { CanonicalMessage } from "../../../foundations/schemas/inference.js";

describe("WS5: Vendor Failure Paths & Unified Error Classifier", () => {
  const dummyCred = {
    id: "test-cred",
    ref: { kind: "none" as const },
    isResolvable: async () => true,
    acquireLease: () => ({
      leaseId: "l1",
      secret: async () => ({ kind: "api_key" as const, value: "sk-test" }),
      release: async () => {},
      isReleased: false,
    }),
    activeLeaseCount: 0,
  };

  const dummyTarget: InferenceTarget = {
    providerAccount: "primary-account",
    upstreamProvider: "openai",
    model: "gpt-4o",
    credential: dummyCred,
  };

  it("B-13: classifyInferenceError normalizes HTTP status, network errors, and quotas", () => {
    expect(classifyInferenceError("", false, 429).code).toBe("rate_limit");
    expect(classifyInferenceError("", false, 429).retryable).toBe(true);

    expect(classifyInferenceError("", false, 401).code).toBe("auth");
    expect(classifyInferenceError("", false, 401).retryable).toBe(false);

    expect(classifyInferenceError("Rate limit reached. Retry after 20 seconds").code).toBe("rate_limit");
    expect(classifyInferenceError("Rate limit reached. Retry after 20 seconds").retryAfterMs).toBe(20_000);

    expect(classifyInferenceError("ECONNRESET fetch failed").code).toBe("network");
    expect(classifyInferenceError("ECONNRESET fetch failed").retryable).toBe(true);

    expect(classifyInferenceError("Model not found in catalog").code).toBe("unknown_model");
    expect(classifyInferenceError("Model not found in catalog").retryable).toBe(false);
  });

  it("B-10: PiLanguageRaw.chat() catches raw throws and wraps in InferenceError", async () => {
    const raw = new PiLanguageRaw();
    (raw as any).models = {
      getModel: () => ({ api: "openai-completions" }),
      stream: () => {
        throw new Error("Raw network connection reset socket hang up");
      },
    };

    const req: LanguageRequest = {
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };

    await expect(raw.chat(dummyTarget, req)).rejects.toThrow(InferenceError);

    try {
      await raw.chat(dummyTarget, req);
    } catch (err: any) {
      expect(err).toBeInstanceOf(InferenceError);
      expect(err.code).toBe("network");
      expect(err.providerAccount).toBe("primary-account");
      expect(err.model).toBe("gpt-4o");
      expect(err.retryable).toBe(true);
      expect(err.cause).toBeDefined();
    }
  });

  it("B-11: PiLanguageRaw.chatStream() drains open blocks and preserves partial usage on error", async () => {
    const raw = new PiLanguageRaw();
    (raw as any).models = {
      getModel: () => ({ api: "openai-completions" }),
      stream: async function* () {
        yield { type: "start" };
        yield { type: "text_start", contentIndex: 0 };
        yield { type: "text_delta", contentIndex: 0, delta: "partial " };
        yield { type: "thinking_start", contentIndex: 1 };
        yield {
          type: "error",
          error: {
            errorMessage: "Context window exceeded",
            usage: { input: 100, output: 50, totalTokens: 150 },
          },
        };
      },
    };

    const req: LanguageRequest = {
      messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    };

    const events: any[] = [];
    for await (const event of raw.chatStream(dummyTarget, req)) {
      events.push(event);
    }

    // Must emit content_block_stop for both open blocks before error event
    const stopEvents = events.filter((e) => e.type === "content_block_stop");
    expect(stopEvents.length).toBe(2);
    expect(stopEvents[0].index).toBe(0);
    expect(stopEvents[1].index).toBe(1);

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.code).toBe("context_overflow");
    expect(errorEvent.partialUsage?.promptTokens).toBe(100);
    expect(errorEvent.partialUsage?.completionTokens).toBe(50);
    expect(errorEvent.partialUsage?.totalTokens).toBe(150);
  });

  it("B-12: user abort in image backends is classified as non-retryable invalid_request", async () => {
    const piImg = new PiImageRaw();
    const abortCtrl = new AbortController();
    abortCtrl.abort(); // User aborted immediately

    await expect(
      piImg.generate(dummyTarget, { prompt: "a cat" }, { signal: abortCtrl.signal }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
    });

    const googleImg = new GoogleImageRaw();
    await expect(
      googleImg.generate(dummyTarget, { prompt: "a cat" }, { signal: abortCtrl.signal }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
  });

  it("S-10: pi-canonical-converter throws InferenceError on unrepresentable block types", () => {
    const invalidMessages: CanonicalMessage[] = [
      {
        role: "user",
        content: [{ type: "unsupported_custom_block", data: "test" } as any],
      },
    ];

    expect(() => canonicalToPiContext(invalidMessages)).toThrowError(
      /Block type "unsupported_custom_block" is not supported/,
    );
  });
});
