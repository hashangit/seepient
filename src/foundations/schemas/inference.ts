import Type from "typebox";

// ── Thinking Level ────────────────────────────────────────────────────────
export const ThinkingLevelSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("max"),
]);
export type ThinkingLevel = Type.Static<typeof ThinkingLevelSchema>;

// ── Pricing & Models ──────────────────────────────────────────────────────
export const PricingSchema = Type.Object({
  promptPerMillion: Type.Optional(Type.Number({ minimum: 0 })),
  completionPerMillion: Type.Optional(Type.Number({ minimum: 0 })),
  cachedPromptPerMillion: Type.Optional(Type.Number({ minimum: 0 })),
  reasoningPerMillion: Type.Optional(Type.Number({ minimum: 0 })),
  imagePerItem: Type.Optional(Type.Number({ minimum: 0 })),
});
export type Pricing = Type.Static<typeof PricingSchema>;

export const UpstreamModelSchema = Type.Object({
  id: Type.String(),
  upstreamProvider: Type.String(),
  displayName: Type.String(),
  contextWindow: Type.Integer({ minimum: 1 }),
  capabilities: Type.Object({
    toolUse: Type.Boolean(),
    streaming: Type.Boolean(),
    vision: Type.Boolean(),
    imageGenerate: Type.Optional(Type.Boolean()),
    imageVariation: Type.Optional(Type.Boolean()),
    imageEdit: Type.Optional(Type.Boolean()),
    imageMask: Type.Optional(Type.Boolean()),
    aspectRatios: Type.Optional(Type.Array(Type.String())),
    tts: Type.Optional(Type.Boolean()),
    stt: Type.Optional(Type.Boolean()),
    video: Type.Optional(Type.Boolean()),
  }),
  supportedReasoningLevels: Type.Optional(Type.Array(ThinkingLevelSchema)),
  pricing: Type.Optional(PricingSchema),
  provenance: Type.Union([
    Type.Literal("pi-catalog"),
    Type.Literal("seepient-curated"),
    Type.Literal("user-declared"),
    Type.Literal("provider-discovered"),
  ]),
});
export type UpstreamModel = Type.Static<typeof UpstreamModelSchema>;

// ── Content Blocks ────────────────────────────────────────────────────────
export const TextBlockSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
});
export type TextBlock = Type.Static<typeof TextBlockSchema>;

export const ImageBlockSchema = Type.Union([
  Type.Object({
    type: Type.Literal("image"),
    mediaType: Type.Union([
      Type.Literal("image/png"),
      Type.Literal("image/jpeg"),
      Type.Literal("image/webp"),
      Type.Literal("image/gif"),
    ]),
    data: Type.String(),
    detail: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("high")])),
  }),
  Type.Object({
    type: Type.Literal("image"),
    mediaType: Type.Union([
      Type.Literal("image/png"),
      Type.Literal("image/jpeg"),
      Type.Literal("image/webp"),
      Type.Literal("image/gif"),
    ]),
    url: Type.String(),
    detail: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("high")])),
  }),
  Type.Object({
    type: Type.Literal("image"),
    mediaType: Type.Union([
      Type.Literal("image/png"),
      Type.Literal("image/jpeg"),
      Type.Literal("image/webp"),
      Type.Literal("image/gif"),
    ]),
    artifact: Type.Object({ ref: Type.String(), mediaType: Type.String() }),
    detail: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("high")])),
  }),
]);
export type ImageBlock = Type.Static<typeof ImageBlockSchema>;

export const AudioBlockSchema = Type.Union([
  Type.Object({
    type: Type.Literal("audio"),
    mediaType: Type.Union([
      Type.Literal("audio/wav"),
      Type.Literal("audio/mp3"),
      Type.Literal("audio/ogg"),
    ]),
    data: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("audio"),
    mediaType: Type.Union([
      Type.Literal("audio/wav"),
      Type.Literal("audio/mp3"),
      Type.Literal("audio/ogg"),
    ]),
    url: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("audio"),
    mediaType: Type.Union([
      Type.Literal("audio/wav"),
      Type.Literal("audio/mp3"),
      Type.Literal("audio/ogg"),
    ]),
    artifact: Type.Object({ ref: Type.String(), mediaType: Type.String() }),
  }),
]);
export type AudioBlock = Type.Static<typeof AudioBlockSchema>;

export const BinaryBlockSchema = Type.Union([
  Type.Object({
    type: Type.Literal("binary"),
    mediaType: Type.String(),
    data: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("binary"),
    mediaType: Type.String(),
    url: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("binary"),
    mediaType: Type.String(),
    artifact: Type.Object({ ref: Type.String(), mediaType: Type.String() }),
  }),
]);
export type BinaryBlock = Type.Static<typeof BinaryBlockSchema>;

export const ToolUseBlockSchema = Type.Object({
  type: Type.Literal("tool_use"),
  id: Type.String(),
  name: Type.String(),
  input: Type.Record(Type.String(), Type.Unknown()),
});
export type ToolUseBlock = Type.Static<typeof ToolUseBlockSchema>;

export const ToolResultContentSchema = Type.Union([
  TextBlockSchema,
  ImageBlockSchema,
  AudioBlockSchema,
  BinaryBlockSchema,
]);
export type ToolResultContent = Type.Static<typeof ToolResultContentSchema>;

export const ToolResultBlockSchema = Type.Object({
  type: Type.Literal("tool_result"),
  toolUseId: Type.String(),
  content: Type.Array(ToolResultContentSchema, { minItems: 1 }),
  isError: Type.Optional(Type.Boolean()),
});
export type ToolResultBlock = Type.Static<typeof ToolResultBlockSchema>;

export const ReasoningBlockSchema = Type.Object({
  type: Type.Literal("reasoning"),
  text: Type.String(),
  signature: Type.Optional(Type.String()),
  signatureProvenance: Type.Optional(
    Type.Object({
      adapter: Type.String(),
      providerApi: Type.String(),
      upstreamProvider: Type.String(),
    }),
  ),
});
export type ReasoningBlock = Type.Static<typeof ReasoningBlockSchema>;

export const ContentBlockSchema = Type.Union([
  TextBlockSchema,
  ImageBlockSchema,
  AudioBlockSchema,
  BinaryBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ReasoningBlockSchema,
]);
export type ContentBlock = Type.Static<typeof ContentBlockSchema>;

// ── Messages ──────────────────────────────────────────────────────────────
export const SystemMessageSchema = Type.Object({
  role: Type.Literal("system"),
  content: Type.Array(TextBlockSchema, { minItems: 1 }),
});
export type SystemMessage = Type.Static<typeof SystemMessageSchema>;

export const UserMessageSchema = Type.Object({
  role: Type.Literal("user"),
  content: Type.Array(
    Type.Union([TextBlockSchema, ImageBlockSchema, AudioBlockSchema, BinaryBlockSchema, ToolResultBlockSchema]),
    { minItems: 1 },
  ),
});
export type UserMessage = Type.Static<typeof UserMessageSchema>;

export const AssistantMessageSchema = Type.Object({
  role: Type.Literal("assistant"),
  content: Type.Array(
    Type.Union([TextBlockSchema, ReasoningBlockSchema, ToolUseBlockSchema]),
    { minItems: 1 },
  ),
});
export type AssistantMessage = Type.Static<typeof AssistantMessageSchema>;

export const ToolMessageSchema = Type.Object({
  role: Type.Literal("tool"),
  content: Type.Array(ToolResultBlockSchema, { minItems: 1, maxItems: 1 }),
});
export type ToolMessage = Type.Static<typeof ToolMessageSchema>;

export const CanonicalMessageSchema = Type.Union([
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
]);
export type CanonicalMessage = Type.Static<typeof CanonicalMessageSchema>;

// ── Usage ─────────────────────────────────────────────────────────────────
export const UsageSchema = Type.Object({
  inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  totalTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  promptTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  completionTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cacheReadTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cacheWriteTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cachedPromptTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  reasoningTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  estimatedCost: Type.Optional(Type.Number({ minimum: 0 })),
  cost: Type.Optional(Type.Number({ minimum: 0 })),
});
export type Usage = Type.Static<typeof UsageSchema>;

// ── Stop Reason ──────────────────────────────────────────────────────────
export const StopReasonSchema = Type.Union([
  Type.Literal("end_turn"),
  Type.Literal("tool_use"),
  Type.Literal("max_tokens"),
  Type.Literal("stop_sequence"),
  Type.Literal("timeout"),
  Type.Literal("context_overflow"),
  Type.Literal("safety"),
]);
export type StopReason = Type.Static<typeof StopReasonSchema>;

// ── Streaming Events ──────────────────────────────────────────────────────
export const StreamEventSchema = Type.Union([
  Type.Object({
    type: Type.Literal("start"),
    providerResponseId: Type.Optional(Type.String()),
    resolvedModel: Type.Object({
      modelId: Type.String(),
      providerAccount: Type.String(),
    }),
  }),
  Type.Object({
    type: Type.Literal("content_block_start"),
    index: Type.Integer({ minimum: 0 }),
    block: ContentBlockSchema,
  }),
  Type.Object({
    type: Type.Literal("content_block_delta"),
    index: Type.Integer({ minimum: 0 }),
    delta: Type.Union([
      Type.Object({ type: Type.Literal("text_delta"), text: Type.String() }),
      Type.Object({ type: Type.Literal("tool_input_delta"), partialJson: Type.String() }),
      Type.Object({
        type: Type.Literal("reasoning_delta"),
        text: Type.String(),
        signatureDelta: Type.Optional(Type.String()),
      }),
      Type.Object({ type: Type.Literal("image_delta"), partialData: Type.String() }),
      Type.Object({ type: Type.Literal("audio_delta"), partialData: Type.String() }),
    ]),
  }),
  Type.Object({
    type: Type.Literal("content_block_stop"),
    index: Type.Integer({ minimum: 0 }),
    signature: Type.Optional(Type.String()),
    signatureProvenance: Type.Optional(
      Type.Object({
        adapter: Type.String(),
        providerApi: Type.String(),
        upstreamProvider: Type.String(),
      }),
    ),
  }),
  Type.Object({
    type: Type.Literal("finish"),
    stopReason: StopReasonSchema,
    usage: Type.Optional(UsageSchema),
  }),
  Type.Object({
    type: Type.Literal("error"),
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
      retryable: Type.Boolean(),
      retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
      providerDiagnostic: Type.Optional(Type.Unknown()),
    }),
    partialUsage: Type.Optional(UsageSchema),
  }),
  Type.Object({
    type: Type.Literal("abort"),
    reason: Type.Optional(Type.String()),
    partialUsage: Type.Optional(UsageSchema),
  }),
]);
export type StreamEvent = Type.Static<typeof StreamEventSchema>;

// ── Responses & Requests ──────────────────────────────────────────────────
export const InferenceResponseSchema = Type.Object({
  message: AssistantMessageSchema,
  stopReason: StopReasonSchema,
  usage: Type.Optional(UsageSchema),
  providerResponseId: Type.Optional(Type.String()),
});
export type InferenceResponse = Type.Static<typeof InferenceResponseSchema>;

export const ImageRequestSchema = Type.Object({
  prompt: Type.String(),
  operation: Type.Optional(
    Type.Union([
      Type.Literal("generate"),
      Type.Literal("variation"),
      Type.Literal("edit"),
      Type.Literal("mask"),
    ]),
  ),
  aspectRatio: Type.Optional(Type.String()),
  qualityPreset: Type.Optional(
    Type.Union([
      Type.Literal("low"),
      Type.Literal("standard"),
      Type.Literal("high"),
    ]),
  ),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  inputImage: Type.Optional(ImageBlockSchema),
  mask: Type.Optional(ImageBlockSchema),
  style: Type.Optional(Type.String()),
  outputDir: Type.Optional(Type.String()),
});
export type ImageRequest = Type.Static<typeof ImageRequestSchema>;

export const ImageResultItemSchema = Type.Union([
  Type.Object({
    url: Type.String(),
    base64: Type.Optional(Type.String()),
    mimeType: Type.String(),
    revisedPrompt: Type.Optional(Type.String()),
  }),
  Type.Object({
    url: Type.Optional(Type.String()),
    base64: Type.String(),
    mimeType: Type.String(),
    revisedPrompt: Type.Optional(Type.String()),
  }),
]);

export const ImageResultSchema = Type.Object({
  images: Type.Array(ImageResultItemSchema, { minItems: 1 }),
  usage: Type.Optional(UsageSchema),
});
export type ImageResult = Type.Static<typeof ImageResultSchema>;
