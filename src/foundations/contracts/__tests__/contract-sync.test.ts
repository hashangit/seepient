import { describe, it, expect } from "vitest";
import AjvModule from "ajv";
const Ajv = (AjvModule as any).default ?? AjvModule;
import {
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ReasoningBlockSchema,
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
  StreamEventSchema,
  ImageRequestSchema,
  ImageResultSchema,
  ProviderEffectiveConfigSchema,
  OverlayDocumentSchema,
  CredentialRefSchema,
  ThinkingLevelSchema,
  type ImageRequest,
  type ImageResult,
  type ThinkingLevel,
  type CredentialRef,
  type ProviderEffectiveConfig,
  type OverlayDocument,
} from "../../schemas/index.js";
import type {
  CreateSeepientOptions,
  GenerateTextOptions,
  GenerateImageOptions,
  AgentPurpose,
} from "../sdk-fixture.js";

// Compile-time type equivalence helper
type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;

// ── Compile-time type-level sync assertions ──────────────────────────────
const _assertQualityPresetSync: AssertEqual<
  GenerateImageOptions["qualityPreset"],
  ImageRequest["qualityPreset"]
> = true;

const _assertThinkingLevelSync: AssertEqual<
  ThinkingLevel,
  NonNullable<NonNullable<GenerateTextOptions["override"]>["thinkingLevel"]>
> = true;

const _assertAgentPurposeValues: AssertEqual<
  AgentPurpose,
  "plan" | "text" | "vision" | "commit"
> = true;

describe("contract sync and schema validation (QS-P1.1, QS-P1.2, QS-P1.3)", () => {
  const ajv = new Ajv({ strict: false });

  it("verifies compile-time type equivalence between SDK contracts and schemas", () => {
    expect(_assertQualityPresetSync).toBe(true);
    expect(_assertThinkingLevelSync).toBe(true);
    expect(_assertAgentPurposeValues).toBe(true);
  });

  it("validates text and reasoning content blocks", () => {
    const validateText = ajv.compile(TextBlockSchema);
    expect(validateText({ type: "text", text: "hello" })).toBe(true);
    expect(validateText({ type: "text", text: 123 })).toBe(false);

    const validateReasoning = ajv.compile(ReasoningBlockSchema);
    expect(
      validateReasoning({
        type: "reasoning",
        text: "thinking step",
        signature: "sig-123",
        signatureProvenance: {
          adapter: "pi-ai",
          providerApi: "anthropic-messages",
          upstreamProvider: "anthropic",
        },
      }),
    ).toBe(true);
  });

  it("validates canonical assistant message schema", () => {
    const validateAssistant = ajv.compile(AssistantMessageSchema);
    const valid = {
      role: "assistant",
      content: [
        { type: "text", text: "Explaining..." },
        {
          type: "tool_use",
          id: "call-1",
          name: "read_file",
          input: { path: "test.txt" },
        },
      ],
    };
    expect(validateAssistant(valid)).toBe(true);

    const invalid = {
      role: "assistant",
      content: [], // minItems: 1
    };
    expect(validateAssistant(invalid)).toBe(false);
  });

  it("validates credential reference schema", () => {
    const validateCred = ajv.compile(CredentialRefSchema);
    expect(validateCred({ kind: "env", name: "OPENAI_API_KEY" })).toBe(true);
    expect(validateCred({ kind: "seepient", id: "cred-1" })).toBe(true);
    expect(validateCred({ kind: "none" })).toBe(true);
    expect(validateCred({ kind: "unknown_kind" })).toBe(false);
  });

  it("validates image request schema with standard and hd quality presets", () => {
    const validateImage = ajv.compile(ImageRequestSchema);
    expect(
      validateImage({
        prompt: "A landscape painting",
        operation: "generate",
        qualityPreset: "standard",
        count: 1,
      }),
    ).toBe(true);

    expect(
      validateImage({
        prompt: "A landscape painting",
        operation: "generate",
        qualityPreset: "hd",
        count: 1,
      }),
    ).toBe(true);

    expect(
      validateImage({
        prompt: "A landscape painting",
        operation: "generate",
        qualityPreset: "low", // Invalid: only standard and hd allowed
      }),
    ).toBe(false);
  });

  it("validates overlay document schema with deep-patch capability", () => {
    const validateOverlay = ajv.compile(OverlayDocumentSchema);
    const validOverlay = {
      revision: 1,
      updatedAt: "2026-08-16T00:00:00.000Z",
      patch: {
        providers: {
          work: {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            timeoutMs: null, // explicitly unset
          },
        },
      },
    };
    expect(validateOverlay(validOverlay)).toBe(true);
  });

  it("sdk-fixture types compile cleanly and satisfy interface shapes", () => {
    const testOptions: CreateSeepientOptions = {
      providers: {
        "openai-main": {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "env", name: "OPENAI_API_KEY" },
        },
      },
      modelAssignments: {
        text: {
          standard: {
            providerAccount: "openai-main",
            model: "gpt-4o",
          },
        },
      },
    };
    expect(testOptions.providers?.["openai-main"].upstreamProvider).toBe("openai");
  });
});
