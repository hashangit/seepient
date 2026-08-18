import { describe, it, expect } from "vitest";
import {
  StopReasonSchema,
  StreamEventSchema,
  UsageSchema,
  ImageRequestSchema,
  ImageResultSchema,
} from "../inference.js";
import { type InferenceErrorCode } from "../../errors.js";

describe("WS6: Schema ↔ Contract Authority Sync (B-14)", () => {
  it("StopReasonSchema contains exactly the canonical stop reasons", () => {
    const validReasons = [
      "end_turn",
      "tool_use",
      "max_tokens",
      "stop_sequence",
      "context_overflow",
      "safety",
      "error",
      "other",
    ];

    const literals = (StopReasonSchema.anyOf || []).map((s: any) => s.const);
    expect(literals.sort()).toEqual(validReasons.sort());
    expect(literals).not.toContain("timeout"); // Deleted undocumented timeout stop reason
  });

  it("UsageSchema supports canonical token fields with legacy alias backward compatibility", () => {
    const properties = Object.keys(UsageSchema.properties);
    expect(properties).toContain("inputTokens");
    expect(properties).toContain("outputTokens");
    expect(properties).toContain("totalTokens");
    expect(properties).toContain("cacheReadTokens");
    expect(properties).toContain("cacheWriteTokens");
    expect(properties).toContain("cost");

    // Legacy aliases supported for compatibility
    expect(properties).toContain("promptTokens");
    expect(properties).toContain("completionTokens");
  });

  it("StreamEvent abort reasons are strictly typed to user, timeout, or shutdown", () => {
    const abortVariant: any = (StreamEventSchema.anyOf || []).find(
      (v: any) => v.properties?.type?.const === "abort",
    );
    expect(abortVariant).toBeDefined();
    const reasonSchema = abortVariant?.properties?.reason;
    const reasons = (reasonSchema?.anyOf || []).map((s: any) => s.const);
    expect(reasons.sort()).toEqual(["shutdown", "timeout", "user"].sort());
  });

  it("StreamEvent finish event carries optional providerResponseId", () => {
    const finishVariant: any = (StreamEventSchema.anyOf || []).find(
      (v: any) => v.properties?.type?.const === "finish",
    );
    expect(finishVariant?.properties?.providerResponseId).toBeDefined();
  });
});
