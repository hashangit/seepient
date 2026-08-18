// src/foundations/contracts/sdk-fixture.ts — COMPILING CONTRACT
import type {
  ContentBlock,
  CanonicalMessage,
  StreamEvent,
  InferenceResponse,
  ImageBlock,
  ImageResult,
  Usage,
  ThinkingLevel,
  UpstreamModel,
  StopReason,
} from "../schemas/inference.js";
import type { ToolDefinition } from "./tool.js";
import type {
  ModelAssignment,
  PurposeModelMap,
} from "../schemas/provider-config.js";
import type { CredentialStore } from "./credential-store.js";
import type { CredentialRef } from "../schemas/credential-store.js";
import type { InferenceAdapter } from "./backend-ports.js";

export type ProviderId = string;
export type { StopReason };

// ── Factory options (credentials OPTIONAL — zero-config compat) ────────
export interface CreateSeepientOptions {
  providers?: Record<
    ProviderId,
    {
      adapter: "pi-ai" | "vercel-ai" | string;
      upstreamProvider: string;
      credential: CredentialRef;
      baseUrl?: string;
      compat?: "openai" | "anthropic" | "google" | "openai-responses";
      headers?: Record<string, string>;
      timeoutMs?: number;
      ssrfAllowPrivate?: boolean;
    }
  >;
  modelAssignments?: PurposeModelMap;
  credentials?: CredentialStore; // optional — if omitted, env-only path
  configFile?: string;
  overlayFile?: string;
  retryPolicy?: Partial<{
    maxAttempts: number;
    operationTimeoutMs: number;
    streamingIdleTimeoutMs: number;
    backoffBaseMs: number;
    backoffMultiplier: number;
    backoffJitter: number;
    backoffCapMs: number;
    cooldownThreshold: number;
    cooldownDurationMs: number;
  }>;
  strict?: boolean;
  adapter?: InferenceAdapter;
}

// ── Override (explicit precedence) ────────────────────────────────────
export interface ModelAssignmentOverride {
  providerAccount?: ProviderId;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

// ── Agent — purpose restricted to AGENTIC language purposes ───────────
export type AgentPurpose = "plan" | "text" | "vision" | "commit";

export interface AgentOptions {
  purpose: AgentPurpose; // NOT all purposes — media uses instance methods
  tier?: "efficient" | "standard" | "complex";
  override?: ModelAssignmentOverride;
  systemPrompt?: string;
  tools?: ToolDefinition[];
}

export interface GenerateTextOptions extends AgentOptions {
  prompt: string | ContentBlock[];
}

export interface GenerateImageOptions {
  /** Product-level operation. */
  operation?: "generate" | "variation" | "edit" | "mask";
  prompt?: string;
  aspectRatio?: string; // "1:1", "16:9", ...
  qualityPreset?: "low" | "standard" | "high";
  count?: number; // number of images; default 1
  inputImage?: ImageBlock; // for variation/edit/mask
  mask?: ImageBlock; // for masked edit
  outputDir?: string;
  override?: ModelAssignmentOverride; // single override path. No separate `model` field.
}

export interface ResolveOptions {
  purpose: keyof PurposeModelMap;
  tier?: "efficient" | "standard" | "complex";
  override?: ModelAssignmentOverride;
}

export interface TurnResult {
  stopReason: StopReason;
  content: ContentBlock[];
  usage?: Usage;
  servedBy: { providerAccount: ProviderId; model: string; thinkingLevel?: ThinkingLevel };
}

// ── Agent ─────────────────────────────────────────────────────────────
export interface Agent {
  run(input: string | ContentBlock[]): Promise<TurnResult>;
  stream(input: string | ContentBlock[]): Promise<AsyncIterable<StreamEvent>>;
  readonly messages: CanonicalMessage[];
  clearConversation(): void;
  switchModel(override: ModelAssignmentOverride): Promise<void>;
  /** Promote the per-agent override to a persisted assignment. Requires scope + expected revision. */
  promoteOverrideToAssignment(scope: "provider:admin", expectedRevision: number): Promise<{ revision: number }>;
  dispose(): Promise<void>;
}

// ── Seepient instance ─────────────────────────────────────────────────
export interface Seepient {
  createAgent(opts: AgentOptions): Promise<Agent>;
  generateText(opts: GenerateTextOptions): Promise<InferenceResponse>;
  streamText(opts: GenerateTextOptions): Promise<AsyncIterable<StreamEvent>>;
  generateImage(opts: GenerateImageOptions): Promise<ImageResult>;
  resolve(opts: ResolveOptions): Promise<{ model: UpstreamModel; providerAccount: ProviderId; thinkingLevel?: ThinkingLevel }>;
  getAssignments(): PurposeModelMap;
  getCatalog(): Promise<readonly UpstreamModel[]>;
  reload(): Promise<{ revision: number }>;
  dispose(): Promise<void>;
}

export interface SeepientFactory {
  createSeepient(opts: CreateSeepientOptions): Promise<Seepient>;
}
