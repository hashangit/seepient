import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
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
  StopReasonSchema,
  type ImageRequest,
  type ImageResult,
  type ThinkingLevel,
  type StopReason,
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

const _assertQualityPresetValues: AssertEqual<
  ImageRequest["qualityPreset"],
  "low" | "standard" | "high" | undefined
> = true;

const _assertThinkingLevelSync: AssertEqual<
  ThinkingLevel,
  NonNullable<NonNullable<GenerateTextOptions["override"]>["thinkingLevel"]>
> = true;

const _assertAgentPurposeValues: AssertEqual<
  AgentPurpose,
  "plan" | "text" | "vision" | "commit"
> = true;

const _assertStopReasonValues: AssertEqual<
  StopReason,
  "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "context_overflow" | "safety" | "error" | "other"
> = true;

describe("contract sync and schema validation (QS-P1.1, QS-P1.2, QS-P1.3)", () => {
  const ajv = new Ajv({ strict: false });

  it("verifies compile-time type equivalence between SDK contracts and schemas", () => {
    expect(_assertQualityPresetSync).toBe(true);
    expect(_assertQualityPresetValues).toBe(true);
    expect(_assertThinkingLevelSync).toBe(true);
    expect(_assertAgentPurposeValues).toBe(true);
    expect(_assertStopReasonValues).toBe(true);
  });

  it("validates thinking level and stop reason schemas", () => {
    const validateThinking = ajv.compile(ThinkingLevelSchema);
    expect(validateThinking("high")).toBe(true);
    expect(validateThinking("none")).toBe(true);
    expect(validateThinking("extreme")).toBe(false);

    const validateStopReason = ajv.compile(StopReasonSchema);
    expect(validateStopReason("end_turn")).toBe(true);
    expect(validateStopReason("tool_use")).toBe(true);
    expect(validateStopReason("unknown_stop")).toBe(false);
  });

  it("validates image request qualityPreset with low, standard, and high", () => {
    const validateImage = ajv.compile(ImageRequestSchema);
    expect(validateImage({ prompt: "Test", qualityPreset: "low" })).toBe(true);
    expect(validateImage({ prompt: "Test", qualityPreset: "standard" })).toBe(true);
    expect(validateImage({ prompt: "Test", qualityPreset: "high" })).toBe(true);
    expect(validateImage({ prompt: "Test", qualityPreset: "ultra" })).toBe(false);
  });

  it("validates image result schema requiring at least one of url or base64", () => {
    const validateResult = ajv.compile(ImageResultSchema);
    expect(validateResult({ images: [{ url: "https://example.com/a.png", mimeType: "image/png" }] })).toBe(true);
    expect(validateResult({ images: [{ base64: "YWJj", mimeType: "image/png" }] })).toBe(true);
    expect(validateResult({ images: [{ mimeType: "image/png" }] })).toBe(false); // Invalid: must have url or base64
  });

  it("validates streaming event schema for all variants", () => {
    const validateStream = ajv.compile(StreamEventSchema);

    expect(
      validateStream({
        type: "start",
        resolvedModel: { modelId: "gpt-4o", providerAccount: "work" },
      }),
    ).toBe(true);

    expect(
      validateStream({
        type: "content_block_start",
        index: 0,
        block: { type: "text", text: "" },
      }),
    ).toBe(true);

    expect(
      validateStream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      }),
    ).toBe(true);

    expect(
      validateStream({
        type: "content_block_stop",
        index: 0,
      }),
    ).toBe(true);

    expect(
      validateStream({
        type: "finish",
        stopReason: "end_turn",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    ).toBe(true);

    expect(
      validateStream({
        type: "error",
        error: { code: "rate_limit", message: "Too many requests", retryable: true },
      }),
    ).toBe(true);

    expect(
      validateStream({
        type: "abort",
        reason: "user",
      }),
    ).toBe(true);
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

  it("validates provider effective configuration schema", () => {
    const validateConfig = ajv.compile(ProviderEffectiveConfigSchema);
    const effectiveConfig = {
      schemaVersion: 2,
      revision: 1,
      updatedAt: "2026-08-16T00:00:00.000Z",
      providers: {
        work: {
          adapter: "pi-ai",
          upstreamProvider: "openai",
          credential: { kind: "env", name: "OPENAI_API_KEY" },
        },
      },
      modelAssignments: {
        text: {
          standard: {
            providerAccount: "work",
            model: "gpt-4o",
          },
        },
      },
      retryPolicy: {
        maxAttempts: 3,
        operationTimeoutMs: 60000,
        streamingIdleTimeoutMs: 30000,
        backoffBaseMs: 500,
        backoffMultiplier: 2,
        backoffJitter: 0.25,
        backoffCapMs: 30000,
        cooldownThreshold: 3,
        cooldownDurationMs: 60000,
      },
      ssrf: {
        allowPrivateNetworks: false,
        allowedProtocols: ["https:"],
      },
    };
    expect(validateConfig(effectiveConfig)).toBe(true);
  });

  it("validates overlay document schema with all 3 nested-null patch cases", () => {
    const validateOverlay = ajv.compile(OverlayDocumentSchema);

    // Case 1: unsetting a nested field (timeoutMs: null)
    const patchFieldNull = {
      revision: 1,
      updatedAt: "2026-08-16T00:00:00.000Z",
      patch: {
        providers: {
          work: {
            adapter: "pi-ai",
            upstreamProvider: "openai",
            timeoutMs: null,
          },
        },
      },
    };
    expect(validateOverlay(patchFieldNull)).toBe(true);

    // Case 2: unsetting an entire provider entry (work: null)
    const patchEntryNull = {
      revision: 2,
      updatedAt: "2026-08-16T00:01:00.000Z",
      patch: {
        providers: {
          work: null,
        },
      },
    };
    expect(validateOverlay(patchEntryNull)).toBe(true);

    // Case 3: unsetting an entire section (providers: null)
    const patchSectionNull = {
      revision: 3,
      updatedAt: "2026-08-16T00:02:00.000Z",
      patch: {
        providers: null,
      },
    };
    expect(validateOverlay(patchSectionNull)).toBe(true);
  });

  it("validates all 7 provider test fixtures for existence, structure, and schema conformity", () => {
    const fixturesDir = path.resolve(process.cwd(), "tests/fixtures/providers");
    expect(fs.existsSync(fixturesDir)).toBe(true);

    const fixtureFiles = [
      "openai/chat.json",
      "openai/streaming.json",
      "openai/tools.json",
      "openai/images.json",
      "anthropic/chat.json",
      "anthropic/reasoning.json",
      "google/images.json",
    ];

    // Ensure all 7 fixture files exist and parse
    for (const relPath of fixtureFiles) {
      const fullPath = path.join(fixturesDir, relPath);
      expect(fs.existsSync(fullPath), `Fixture ${relPath} must exist`).toBe(true);
      const content = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      expect(content.provider).toBeDefined();
    }

    // 1. Anthropic reasoning fixture validation against ReasoningBlockSchema
    const reasoningPath = path.join(fixturesDir, "anthropic/reasoning.json");
    const reasoningData = JSON.parse(fs.readFileSync(reasoningPath, "utf-8"));
    const validateReasoning = ajv.compile(ReasoningBlockSchema);
    const thinkingBlock = reasoningData.response.content.find((b: any) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(
      validateReasoning({
        type: "reasoning",
        text: thinkingBlock.thinking,
        signature: thinkingBlock.signature,
      }),
    ).toBe(true);

    // 2. Anthropic chat fixture validation against AssistantMessageSchema
    const anthropicChatPath = path.join(fixturesDir, "anthropic/chat.json");
    const anthropicChatData = JSON.parse(fs.readFileSync(anthropicChatPath, "utf-8"));
    const validateAssistant = ajv.compile(AssistantMessageSchema);
    expect(
      validateAssistant({
        role: "assistant",
        content: anthropicChatData.response.content,
      }),
    ).toBe(true);

    // 3. OpenAI chat fixture validation
    const chatPath = path.join(fixturesDir, "openai/chat.json");
    const chatData = JSON.parse(fs.readFileSync(chatPath, "utf-8"));
    expect(chatData.response.choices[0].message.content).toBeDefined();

    // 4. OpenAI tools fixture validation against ToolUseBlockSchema
    const toolsPath = path.join(fixturesDir, "openai/tools.json");
    const toolsData = JSON.parse(fs.readFileSync(toolsPath, "utf-8"));
    const validateToolUse = ajv.compile(ToolUseBlockSchema);
    const rawTool = toolsData.response.choices[0].message.tool_calls[0];
    expect(
      validateToolUse({
        type: "tool_use",
        id: rawTool.id,
        name: rawTool.function.name,
        input: JSON.parse(rawTool.function.arguments),
      }),
    ).toBe(true);

    // 5. OpenAI streaming fixture validation
    const streamPath = path.join(fixturesDir, "openai/streaming.json");
    const streamData = JSON.parse(fs.readFileSync(streamPath, "utf-8"));
    expect(Array.isArray(streamData.events)).toBe(true);
    expect(streamData.events.length).toBeGreaterThan(0);

    // 6. OpenAI images fixture validation against ImageRequestSchema
    const imagesPath = path.join(fixturesDir, "openai/images.json");
    const imagesData = JSON.parse(fs.readFileSync(imagesPath, "utf-8"));
    const validateImgReq = ajv.compile(ImageRequestSchema);
    expect(
      validateImgReq({
        prompt: imagesData.operations.generate.request.prompt,
        qualityPreset: imagesData.operations.generate.request.quality, // "standard"
      }),
    ).toBe(true);

    // 7. Google images fixture validation
    const googleImagesPath = path.join(fixturesDir, "google/images.json");
    const googleImagesData = JSON.parse(fs.readFileSync(googleImagesPath, "utf-8"));
    expect(googleImagesData.models["gemini-3.1-flash-image"].operations.generate.supported).toBe(true);
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
        commit: {
          standard: {
            providerAccount: "openai-main",
            model: "gpt-4o-mini",
          },
        },
      },
    };
    expect(testOptions.providers?.["openai-main"].upstreamProvider).toBe("openai");
  });
});
