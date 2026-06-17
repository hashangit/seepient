/**
 * Zoe SDK — Shared TypeScript types
 *
 * This file is the single source of truth for all SDK interfaces.
 * Every SDK module imports from here.
 */

import type { ZoeError as ZoeErrorType } from "./errors.js";
import type { Middleware } from "./middleware.js";

// ── Provider ──────────────────────────────────────────────────────────

export type ProviderType = "openai" | "anthropic" | "glm" | "openai-compatible";

export interface MultiProviderConfig {
  openai?: { apiKey: string; model?: string };
  anthropic?: { apiKey: string; model?: string };
  glm?: { apiKey: string; model?: string };
  "openai-compatible"?: { apiKey: string; baseUrl: string; model?: string };
  default: ProviderType;
}

// ── Permissions ────────────────────────────────────────────────────────

export type ToolRiskCategory = "safe" | "edit" | "communications" | "destructive";
export type PermissionLevel = "strict" | "moderate" | "permissive";

// ── Identity (Track 2 — Channels foundation, spec 002 §4.4) ────────────
// Single source of truth for channel/conversation identity types. Additive;
// existing CLI/SDK/Server sessions have no conversation identity and remain
// valid (all fields on Message/SessionData are optional). These are the
// memory layer's join keys (spec §4.2) — do not redefine elsewhere.

/** Author role within a conversation. Drives tool-approval gating + prompt context. */
export type AuthorRole = "admin" | "member" | "guest";

/** The platform a conversation lives on. Includes the existing runtime adapters. */
export type ChannelPlatform =
  | "telegram"
  | "whatsapp"
  | "slack"
  | "discord"
  | "teams"
  | "cli"
  | "sdk"
  | "server";

/** Conversation shape — affects author-prefix rendering and approval UX. */
export type ConversationType = "dm" | "group" | "channel";

// ── Messages ──────────────────────────────────────────────────────────

export interface Message {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  timestamp: number;
  // Track 2 identity (spec 002 §4.4). Optional: omitted on legacy messages
  // and on system/tool roles. `authorId` is the resolved canonical userId
  // (the memory-layer join key); `platformSenderId` is the raw platform id
  // kept for audit/debug.
  authorId?: string;
  authorName?: string;
  authorRole?: AuthorRole;
  platformSenderId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
}

// ── Steps ─────────────────────────────────────────────────────────────

export interface StepResult {
  type: "text" | "tool_call" | "text_delta" | "tool_progress";
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    result: string;
    duration: number;
  };
  /** For tool_progress: identifies which in-flight tool call the chunk belongs to. */
  toolCallId?: string;
  /** For tool_progress: the tool name + args (so the UI can render the block). */
  name?: string;
  args?: Record<string, unknown>;
  /** Tool-specific structured payload (e.g. write_file's FileWriteMetadata) for
   *  adapters to render. Populated only on `tool_call` steps whose handler
   *  returned a ToolResult with metadata. NEVER enters message history. */
  metadata?: Record<string, unknown>;
  timestamp: number;
}

// ── Usage ─────────────────────────────────────────────────────────────

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

export interface CumulativeUsage {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCost: number;
  requestCount: number;
}

// ── Tools ─────────────────────────────────────────────────────────────

export interface UserToolDefinition {
  name?: string;
  description: string;
  parameters: unknown; // JSON Schema object at runtime
  execute: (args: unknown, context: ToolContext) => Promise<string | ToolResult>;
}

export interface ToolContext {
  onUpdate?: (progress: { percentage?: number; message?: string }) => void;
  signal?: AbortSignal;
  config?: Record<string, unknown>;
}

export interface ToolResult {
  output: string;
  success: boolean;
  metadata?: Record<string, unknown>;
}

// ── Tool Approval ─────────────────────────────────────────────────────

export interface ApproveToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Adapter-provided callback invoked before every tool execution.
 * Return `true` to approve, `false` to deny (the tool is skipped
 * and "User denied tool execution" is returned as the tool output).
 *
 * Each adapter implements its own UX:
 *  - CLI: inquirer prompt (with ESC interrupt suspended)
 *  - SDK: user-supplied callback or auto-approve
 *  - Server: WebSocket round-trip to client
 */
export type ApproveToolFn = (call: ApproveToolCall) => Promise<boolean>;

// ── Hooks ─────────────────────────────────────────────────────────────

export interface Hooks {
  beforeToolCall?: (
    call: { name: string; args: Record<string, unknown> },
  ) => void | Promise<void>;
  afterToolCall?: (
    result: { name: string; output: string; duration: number },
  ) => void | Promise<void>;
  onStep?: (step: StepResult) => void | Promise<void>;
  onError?: (error: ZoeErrorType) => void | Promise<void>;
  onFinish?: (result: GenerateTextResult) => void | Promise<void>;
}

// ── generateText ──────────────────────────────────────────────────────

export interface GenerateTextOptions {
  model?: string;
  provider?: ProviderType;
  systemPrompt?: string;
  tools?: string[] | UserToolDefinition[];
  skills?: string[];
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  output?: unknown; // ZodSchema
  hooks?: Hooks;
  signal?: AbortSignal;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  middleware?: Middleware[];
  approveTool?: ApproveToolFn;
  permissionLevel?: PermissionLevel;
}

export interface GenerateTextResult {
  text: string;
  data?: unknown;
  error?: { message: string; issues: unknown };
  steps: StepResult[];
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: "stop" | "length" | "max_steps" | "error";
  messages: Message[];
}

// ── streamText ────────────────────────────────────────────────────────

export interface StreamTextOptions extends GenerateTextOptions {
  onText?: (delta: string) => void;
  onToolCall?: (
    tool: { name: string; args: Record<string, unknown>; callId: string },
  ) => void;
  onToolResult?: (
    result: { callId: string; output: string; success: boolean },
  ) => void;
  onStep?: (step: StepResult) => void;
  onError?: (error: ZoeErrorType) => void;
}

export interface StreamTextResult {
  textStream: AsyncIterable<string>;
  steps: AsyncIterable<StepResult>;
  fullText: Promise<string>;
  usage: Promise<Usage>;
  finishReason: Promise<string>;
  abort: () => void;
  toResponse: () => Response;
  toSSEStream: () => ReadableStream;
}

// ── createAgent ───────────────────────────────────────────────────────

export interface AgentCreateOptions {
  model?: string;
  provider?: ProviderType;
  systemPrompt?: string;
  tools?: string[] | UserToolDefinition[];
  skills?: string[];
  maxSteps?: number;
  permissionLevel?: PermissionLevel;
  persist?: string | PersistenceBackend | PersistenceConfig | SessionStore;
  hooks?: Hooks;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  middleware?: Middleware[];
  approveTool?: ApproveToolFn;
}

export interface SdkAgent {
  chat(message: string): Promise<AgentResponse>;
  chatStream(message: string, options?: StreamTextOptions): Promise<StreamTextResult>;
  switchProvider(provider: ProviderType, model?: string): Promise<void>;
  setSystemPrompt(prompt: string): void;
  setTools(tools: string[]): void;
  abort(): void;
  clear(): void;
  getHistory(): Message[];
  getUsage(): CumulativeUsage;
}

export interface AgentResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

// ── Session ───────────────────────────────────────────────────────────

/**
 * Composable persistence backend. Implementations handle raw storage
 * (file system, Redis, SQLite, etc.). Server-specific metadata (TTL,
 * apiKeyHash) flows through the `metadata` field on `SessionData`.
 */
export interface PersistenceBackend {
  /** Brand discriminator to distinguish from SessionStore */
  __persistenceBackend: true;
  save(id: string, data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  delete(id: string): Promise<void>;
  list(): Promise<string[]>;
}

/**
 * Configuration object for creating a persistence backend via the factory.
 * `type` selects the backend; remaining keys are backend-specific options.
 */
export interface PersistenceConfig {
  type: string;
  [key: string]: unknown;
}

/**
 * @deprecated Use `PersistenceBackend` instead. Kept for backward compatibility.
 */
export interface SessionStore {
  save(sessionId: string, messages: Message[]): Promise<void>;
  load(sessionId: string): Promise<Message[] | null>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface SessionData {
  id: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  provider?: ProviderType;
  model?: string;
  /** Arbitrary metadata for backends or consumers (e.g., TTL, apiKeyHash). */
  metadata?: Record<string, unknown>;
  // Track 2 conversation identity (spec 002 §4.4). Optional on legacy
  // sessions — existing UUID sessions keep working unchanged. The composite
  // identity lives in these typed fields, NOT encoded in the id string
  // (spec §4.3 — avoids collisions, respects the /^[a-zA-Z0-9-]+$/ id
  // regex, requires no backend changes).
  platform?: ChannelPlatform;
  conversationId?: string;
  conversationType?: ConversationType;
  botId?: string;
  /** Resolved canonical user — the memory-layer join key (spec §4.2). */
  userId?: string;
}

// ── Skills ────────────────────────────────────────────────────────────

export interface SkillMetadata {
  name: string;
  description: string;
  tags: string[];
}

// ── Errors ────────────────────────────────────────────────────────────
// Error classes live in ./errors.ts. We re-export them here so that
// existing consumers that import { ZoeError } from "./types.js"
// continue to compile without changes.

export { ZoeError, ProviderError, ToolError, MaxStepsError, AbortedError } from "./errors.js";

