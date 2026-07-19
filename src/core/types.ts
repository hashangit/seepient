/**
 * Seepient SDK — Shared TypeScript types
 *
 * This file is the single source of truth for all SDK interfaces.
 * Every SDK module imports from here.
 */

import type { SeepientError as SeepientErrorType } from "./errors.js";
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

// ── Tool Approval Grants ──────────────────────────────────────────────

/** Where a remembered approval applies. Session grants are process-lifetime. */
export type GrantScope = "session" | "project" | "global";

/** "once" = do not remember; the others map to a persisted grant scope. */
export type ApprovalScope = "once" | GrantScope;

/**
 * Backward-compatible approval return. A bare boolean is still accepted and
 * is equivalent to `{ approved, scope: "once" }`. Adapters that surface
 * scoped options return the object form so the loop can record a grant.
 */
export type ApprovalDecision = boolean | { approved: boolean; scope?: ApprovalScope };

/**
 * LLM-authored human-in-the-loop context attached to a risky tool call.
 * Extracted by the agent loop from the tool's `approval` arg and surfaced to
 * the adapter so the user can make an informed decision. `implications` is
 * per-scope; the adapter falls back to a template when a scope is missing.
 */
export interface ApprovalContext {
  title: string;
  description: string;
  implications?: Partial<Record<GrantScope, string>>;
}

// ── Messages ──────────────────────────────────────────────────────────

export interface Message {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  timestamp: number;
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
  /** LLM-authored gate context, built by the loop from the tool's `approval` arg. */
  approvalContext?: ApprovalContext;
}

/**
 * Adapter-provided callback invoked before every tool execution.
 * Return `true` (or `{ approved: true }`) to approve, `false` (or
 * `{ approved: false }`) to deny — the tool is skipped and "User denied
 * tool execution" is returned as the tool output. When the object form
 * carries a `scope` other than "once" (and a grantStore is configured),
 * the loop persists the decision as a grant so future matching calls
 * skip this prompt.
 *
 * Each adapter implements its own UX:
 *  - CLI TUI: bordered multi-option panel with per-scope implications
 *  - CLI readline: y/n (defaults to "once")
 *  - SDK: user-supplied callback or auto-approve
 *  - Server: WebSocket round-trip to client
 */
export type ApproveToolFn = (call: ApproveToolCall) => Promise<ApprovalDecision>;

// ── Hooks ─────────────────────────────────────────────────────────────

export interface Hooks {
  beforeToolCall?: (
    call: { name: string; args: Record<string, unknown> },
  ) => void | Promise<void>;
  afterToolCall?: (
    result: { name: string; output: string; duration: number },
  ) => void | Promise<void>;
  onStep?: (step: StepResult) => void | Promise<void>;
  onError?: (error: SeepientErrorType) => void | Promise<void>;
  onFinish?: (result: GenerateTextResult) => void | Promise<void>;
}

// ── generateText ──────────────────────────────────────────────────────

/**
 * A pre-granted tool permission for the SDK `grants` option. The matching
 * rules mirror the CLI --allow flag and the GrantStore: `pattern` is a prefix
 * the relevant arg must start with (command string for shell, path for
 * write/edit); omit it for a tool-level grant. Grants skip the approval
 * prompt for matching calls.
 */
export interface GrantSpec {
  tool: string;
  pattern?: string;
}

export interface GenerateTextOptions {
  model?: string;
  provider?: ProviderType;
  systemPrompt?: string;
  tools?: string[] | UserToolDefinition[];
  skills?: string[] | boolean;
  cwd?: string;
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
  /** Pre-grant tools so matching calls skip the approval prompt. */
  grants?: GrantSpec[];
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
  onError?: (error: SeepientErrorType) => void;
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
  skills?: string[] | boolean;
  cwd?: string;
  maxSteps?: number;
  permissionLevel?: PermissionLevel;
  persist?: string | PersistenceBackend | PersistenceConfig | SessionStore;
  hooks?: Hooks;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  middleware?: Middleware[];
  approveTool?: ApproveToolFn;
  /** Pre-grant tools so matching calls skip the approval prompt. */
  grants?: GrantSpec[];
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
}

// ── Skills ────────────────────────────────────────────────────────────

export interface SkillMetadata {
  name: string;
  description: string;
  tags: string[];
}

// ── Errors ────────────────────────────────────────────────────────────
// Error classes live in ./errors.ts. We re-export them here so that
// existing consumers that import { SeepientError } from "./types.js"
// continue to compile without changes.

export { SeepientError, ProviderError, ToolError, MaxStepsError, AbortedError } from "./errors.js";

