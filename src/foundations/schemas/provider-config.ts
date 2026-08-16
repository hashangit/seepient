import Type from "typebox";
import { ThinkingLevelSchema } from "./inference.js";
import { CredentialRefSchema } from "./credential-store.js";

// Helper: Nullable property (Value or Null, and Optional)
const Nullable = (schema: any): any =>
  Type.Optional(Type.Union([schema, Type.Null()]));

// ── User Declared Model ───────────────────────────────────────────────────
export const UserDeclaredModelSchema = Type.Object({
  displayName: Type.Optional(Type.String()),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
  capabilities: Type.Object({
    toolUse: Type.Optional(Type.Boolean()),
    streaming: Type.Optional(Type.Boolean()),
    vision: Type.Optional(Type.Boolean()),
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
  verificationStatus: Type.Literal("unverified"),
});
export type UserDeclaredModel = Type.Static<typeof UserDeclaredModelSchema>;

// ── Provider Entry ────────────────────────────────────────────────────────
export const ProviderEntrySchema = Type.Object({
  adapter: Type.Union([Type.Literal("pi-ai"), Type.Literal("vercel-ai"), Type.String()]),
  upstreamProvider: Type.String(),
  credential: CredentialRefSchema,
  baseUrl: Type.Optional(Type.String({ format: "uri" })),
  compat: Type.Optional(
    Type.Union([
      Type.Literal("openai"),
      Type.Literal("anthropic"),
      Type.Literal("google"),
      Type.Literal("openai-responses"),
    ]),
  ),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600_000 })),
  proxy: Type.Optional(Type.String({ format: "uri" })),
  tls: Type.Optional(Type.Object({ rejectUnauthorized: Type.Boolean() })),
  ssrfAllowPrivate: Type.Optional(Type.Boolean()),
  models: Type.Optional(Type.Record(Type.String(), UserDeclaredModelSchema)),
});
export type ProviderEntry = Type.Static<typeof ProviderEntrySchema>;

// ── Assignments & Purpose Maps ────────────────────────────────────────────
export const ModelAssignmentSchema = Type.Object({
  providerAccount: Type.String(),
  model: Type.String(),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  fallback: Type.Optional(
    Type.Array(
      Type.Object({
        providerAccount: Type.String(),
        model: Type.String(),
        thinkingLevel: Type.Optional(ThinkingLevelSchema),
      }),
    ),
  ),
});
export type ModelAssignment = Type.Static<typeof ModelAssignmentSchema>;

export const TieredAssignmentsSchema = Type.Object({
  standard: ModelAssignmentSchema,
  efficient: Type.Optional(ModelAssignmentSchema),
  complex: Type.Optional(ModelAssignmentSchema),
});
export type TieredAssignments = Type.Static<typeof TieredAssignmentsSchema>;

export const PurposeModelMapSchema = Type.Object({
  plan: Type.Optional(TieredAssignmentsSchema),
  text: TieredAssignmentsSchema,
  coding: Type.Optional(TieredAssignmentsSchema),
  vision: Type.Optional(TieredAssignmentsSchema),
  commit: Type.Optional(TieredAssignmentsSchema),
  media: Type.Optional(
    Type.Object({
      image: Type.Optional(ModelAssignmentSchema),
      speech: Type.Optional(ModelAssignmentSchema),
      transcription: Type.Optional(ModelAssignmentSchema),
      video: Type.Optional(ModelAssignmentSchema),
    }),
  ),
});
export type PurposeModelMap = Type.Static<typeof PurposeModelMapSchema>;

// ── Retry Policy ──────────────────────────────────────────────────────────
export const RetryPolicySchema = Type.Object({
  maxAttempts: Type.Integer({ minimum: 1, maximum: 5, default: 3 }),
  operationTimeoutMs: Type.Integer({ minimum: 1000, maximum: 300_000, default: 60_000 }),
  streamingIdleTimeoutMs: Type.Integer({ minimum: 1000, maximum: 120_000, default: 30_000 }),
  backoffBaseMs: Type.Integer({ minimum: 100, maximum: 10_000, default: 500 }),
  backoffMultiplier: Type.Number({ minimum: 1, maximum: 4, default: 2 }),
  backoffJitter: Type.Number({ minimum: 0, maximum: 1, default: 0.25 }),
  backoffCapMs: Type.Integer({ minimum: 1000, maximum: 120_000, default: 30_000 }),
  cooldownThreshold: Type.Integer({ minimum: 1, maximum: 10, default: 3 }),
  cooldownDurationMs: Type.Integer({ minimum: 1000, maximum: 600_000, default: 60_000 }),
});
export type RetryPolicy = Type.Static<typeof RetryPolicySchema>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  operationTimeoutMs: 60_000,
  streamingIdleTimeoutMs: 30_000,
  backoffBaseMs: 500,
  backoffMultiplier: 2,
  backoffJitter: 0.25,
  backoffCapMs: 30_000,
  cooldownThreshold: 3,
  cooldownDurationMs: 60_000,
};

// ── SSRF Policy ───────────────────────────────────────────────────────────
export const SsrfPolicySchema = Type.Object({
  allowPrivateNetworks: Type.Boolean({ default: false }),
  allowList: Type.Optional(Type.Array(Type.String())),
  allowedProtocols: Type.Array(
    Type.Union([Type.Literal("http:"), Type.Literal("https:")]),
    { default: ["https:"] },
  ),
});
export type SsrfPolicy = Type.Static<typeof SsrfPolicySchema>;

// ── Effective Config ──────────────────────────────────────────────────────
export const ProviderEffectiveConfigSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  revision: Type.Integer({ minimum: 0 }),
  updatedAt: Type.String(),
  providers: Type.Record(Type.String(), ProviderEntrySchema),
  modelAssignments: PurposeModelMapSchema,
  retryPolicy: RetryPolicySchema,
  ssrf: Type.Optional(SsrfPolicySchema),
});
export type ProviderEffectiveConfig = Type.Static<typeof ProviderEffectiveConfigSchema>;

// ── Layer Patches (Nested-null tolerant) ──────────────────────────────────
export const NullableHeadersPatchSchema = Type.Optional(
  Type.Union([
    Type.Null(),
    Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])),
  ]),
);

export const ProviderEntryPatchSchema = Type.Object({
  adapter: Nullable(Type.Union([Type.Literal("pi-ai"), Type.Literal("vercel-ai"), Type.String()])),
  upstreamProvider: Nullable(Type.String()),
  credential: Nullable(CredentialRefSchema),
  baseUrl: Nullable(Type.String({ format: "uri" })),
  compat: Nullable(
    Type.Union([
      Type.Literal("openai"),
      Type.Literal("anthropic"),
      Type.Literal("google"),
      Type.Literal("openai-responses"),
    ]),
  ),
  headers: NullableHeadersPatchSchema,
  timeoutMs: Nullable(Type.Integer({ minimum: 0, maximum: 600_000 })),
  proxy: Nullable(Type.String({ format: "uri" })),
  tls: Nullable(Type.Object({ rejectUnauthorized: Type.Boolean() })),
  ssrfAllowPrivate: Nullable(Type.Boolean()),
  models: Nullable(Type.Record(Type.String(), UserDeclaredModelSchema)),
});
export type ProviderEntryPatch = Type.Static<typeof ProviderEntryPatchSchema>;

export const ModelAssignmentPatchSchema = Type.Object({
  providerAccount: Nullable(Type.String()),
  model: Nullable(Type.String()),
  thinkingLevel: Nullable(ThinkingLevelSchema),
  fallback: Nullable(
    Type.Array(
      Type.Object({
        providerAccount: Type.String(),
        model: Type.String(),
        thinkingLevel: Type.Optional(ThinkingLevelSchema),
      }),
    ),
  ),
});
export type ModelAssignmentPatch = Type.Static<typeof ModelAssignmentPatchSchema>;

export const TieredAssignmentsPatchSchema = Type.Object({
  standard: Nullable(ModelAssignmentPatchSchema),
  efficient: Nullable(ModelAssignmentPatchSchema),
  complex: Nullable(ModelAssignmentPatchSchema),
});
export type TieredAssignmentsPatch = Type.Static<typeof TieredAssignmentsPatchSchema>;

export const PurposeModelMapPatchSchema = Type.Object({
  plan: Nullable(TieredAssignmentsPatchSchema),
  text: Nullable(TieredAssignmentsPatchSchema),
  coding: Nullable(TieredAssignmentsPatchSchema),
  vision: Nullable(TieredAssignmentsPatchSchema),
  commit: Nullable(TieredAssignmentsPatchSchema),
  media: Nullable(
    Type.Object({
      image: Nullable(ModelAssignmentPatchSchema),
      speech: Nullable(ModelAssignmentPatchSchema),
      transcription: Nullable(ModelAssignmentPatchSchema),
      video: Nullable(ModelAssignmentPatchSchema),
    }),
  ),
});
export type PurposeModelMapPatch = Type.Static<typeof PurposeModelMapPatchSchema>;

export const RetryPolicyPatchSchema = Type.Object({
  maxAttempts: Nullable(Type.Integer({ minimum: 1, maximum: 5 })),
  operationTimeoutMs: Nullable(Type.Integer({ minimum: 1000, maximum: 300_000 })),
  streamingIdleTimeoutMs: Nullable(Type.Integer({ minimum: 1000, maximum: 120_000 })),
  backoffBaseMs: Nullable(Type.Integer({ minimum: 100, maximum: 10_000 })),
  backoffMultiplier: Nullable(Type.Number({ minimum: 1, maximum: 4 })),
  backoffJitter: Nullable(Type.Number({ minimum: 0, maximum: 1 })),
  backoffCapMs: Nullable(Type.Integer({ minimum: 1000, maximum: 120_000 })),
  cooldownThreshold: Nullable(Type.Integer({ minimum: 1, maximum: 10 })),
  cooldownDurationMs: Nullable(Type.Integer({ minimum: 1000, maximum: 600_000 })),
});
export type RetryPolicyPatch = Type.Static<typeof RetryPolicyPatchSchema>;

export const ProviderLayerPatchSchema = Type.Object({
  schemaVersion: Type.Optional(Type.Literal(2)),
  providers: Nullable(Type.Record(Type.String(), Type.Union([ProviderEntryPatchSchema, Type.Null()]))),
  modelAssignments: Nullable(PurposeModelMapPatchSchema),
  retryPolicy: Nullable(RetryPolicyPatchSchema),
  ssrf: Nullable(SsrfPolicySchema),
});
export type ProviderLayerPatch = Type.Static<typeof ProviderLayerPatchSchema>;

export const OverlayDocumentSchema = Type.Object({
  revision: Type.Integer({ minimum: 0 }),
  updatedAt: Type.String(),
  patch: ProviderLayerPatchSchema,
});
export type OverlayDocument = Type.Static<typeof OverlayDocumentSchema>;
