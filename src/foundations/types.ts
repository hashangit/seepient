/**
 * Seepient SDK — Shared TypeScript types
 *
 * This file is the single source of truth for all SDK interfaces.
 * Every SDK module imports from here.
 */

import type { SeepientError as SeepientErrorType } from "./errors.js";
import type { Middleware } from "./contracts/middleware.js";
import type { Purpose, Tier } from "./contracts/provider-runtime.js";

export type { Purpose, Tier };

// ── Permissions ────────────────────────────────────────────────────────

export type ToolRiskCategory = "safe" | "edit" | "communications" | "destructive";

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
  reasoning?: string;
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
  /** Spec 021 (FR-007): Per-agent skills registry instance */
  skills?: import("./contracts/skill-registry.js").SkillRegistryContract;
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
  onFinish?: (result: AskSeepientResult) => void | Promise<void>;
}

// ── askSeepient ───────────────────────────────────────────────────────

export interface AskSeepientOptions {
  model?: string;
  provider?: string;
  providerAccount?: string;
  purpose?: Purpose;
  tier?: Tier;
  systemPrompt?: string;
  tools?: (string | UserToolDefinition | import("./contracts/custom-tools.js").AnyToolRegistration)[];
  skills?: string[] | boolean;
  cwd?: string;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  hooks?: Hooks;
  signal?: AbortSignal;
  stream?: boolean;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  middleware?: Middleware[];
  approveTool?: ApproveToolFn;
  approvalBroker?: import("./contracts/permission-policy.js").ApprovalBroker;

  // Streaming & Lifecycle Callbacks
  onText?: (delta: string) => void;
  onToolCall?: (
    tool: { name: string; args: Record<string, unknown>; callId: string },
  ) => void;
  onToolResult?: (
    result: { callId: string; output: string; success: boolean },
  ) => void;
  onStep?: (step: StepResult) => void;
  onError?: (error: SeepientErrorType) => void;

  /**
   * Spec 008 / 017 domain policy pipeline options:
   */
  consentMode?: "ask-everything" | "edit-enabled" | "autonomous";
  deploymentCeiling?: import("./contracts/permission-policy.js").CapabilitySet | import("./contracts/permission-policy.js").Capability[];
  principalPolicy?: import("./contracts/permission-policy.js").CapabilitySet | import("./contracts/permission-policy.js").Capability[];
  /** Optional commit helper override for test/embedder injection. */
  commitHelper?: import("./contracts/execution-brokers.js").CommitHelper;
  /** Optional network adapter override for test/embedder injection. */
  network?: import("./contracts/execution-brokers.js").BrokerNetworkAdapter;
  /** Spec 021 (FR-001/FR-002/FR-003): Typed runtime and store injection */
  runtime?: import("./contracts/provider-runtime.js").ProviderRuntimeContract;
  principalId?: string;
  auditStore?: import("./contracts/execution-brokers.js").AuditStore;
  policyStore?: import("./contracts/execution-brokers.js").PolicyStore;
  capabilityLedger?: import("./contracts/capability-ledger.js").CapabilityLedger;
}

export interface AskSeepientResult {
  text: string;
  steps: StepResult[];
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: "stop" | "length" | "max_steps" | "error";
  messages: Message[];
}

export interface AskSeepientStreamResult {
  textStream: AsyncIterable<string>;
  steps: AsyncIterable<StepResult>;
  fullText: Promise<string>;
  usage: Promise<Usage>;
  finishReason: Promise<string>;
  abort: () => void;
  toResponse: (options?: { headers?: Record<string, string> }) => Response;
  toSSEStream: () => ReadableStream;
}

// ── createSeepient ───────────────────────────────────────────────────

export interface CreateSeepientOptions {
  model?: string;
  provider?: string;
  providerAccount?: string;
  purpose?: Purpose;
  tier?: Tier;
  providers?: Record<string, any>;
  modelAssignments?: import("./schemas/provider-config.js").PurposeModelMap;
  credentials?: import("./contracts/credential-store.js").CredentialStore;
  overlayFile?: string;
  adapter?: import("./contracts/backend-ports.js").InferenceAdapter;
  override?: { providerAccount?: string; model?: string; thinkingLevel?: any };
  systemPrompt?: string;
  tools?: (string | UserToolDefinition | import("./contracts/custom-tools.js").AnyToolRegistration)[];
  skills?: string[] | boolean;
  cwd?: string;
  maxSteps?: number;
  persist?: string | PersistenceBackend | PersistenceConfig | SessionStore;
  hooks?: Hooks;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  middleware?: Middleware[];
  approveTool?: ApproveToolFn;
  approvalBroker?: import("./contracts/permission-policy.js").ApprovalBroker;
  /** Spec 008 / 017 domain policy pipeline options: */
  consentMode?: "ask-everything" | "edit-enabled" | "autonomous";
  deploymentCeiling?: import("./contracts/permission-policy.js").CapabilitySet | import("./contracts/permission-policy.js").Capability[];
  principalPolicy?: import("./contracts/permission-policy.js").CapabilitySet | import("./contracts/permission-policy.js").Capability[];
  /** Optional commit helper override for test/embedder injection. */
  commitHelper?: import("./contracts/execution-brokers.js").CommitHelper;
  /** Optional network adapter override for test/embedder injection. */
  network?: import("./contracts/execution-brokers.js").BrokerNetworkAdapter;
  /** Spec 021 (FR-001/FR-002/FR-003/FR-006): Typed runtime, session, and store injection */
  runtime?: import("./contracts/provider-runtime.js").ProviderRuntimeContract;
  principalId?: string;
  sessionId?: string;
  auditStore?: import("./contracts/execution-brokers.js").AuditStore;
  policyStore?: import("./contracts/execution-brokers.js").PolicyStore;
  capabilityLedger?: import("./contracts/capability-ledger.js").CapabilityLedger;
}

export interface Seepient {
  readonly sessionId: string;
  chat(message: string): Promise<AgentResponse>;
  chatStream(message: string, options?: Omit<AskSeepientOptions, "stream" | "signal">): Promise<AskSeepientStreamResult>;
  /** Switch the provider account (and optionally model) used for subsequent calls; one argument switches the model only. */
  switchProvider(accountOrModel: string, model?: string): Promise<void>;
  setSystemPrompt(prompt: string): void;
  setTools(tools: string[]): void;
  abort(): void;
  clear(): void;
  getHistory(): Message[];
  getUsage(): CumulativeUsage;
  /** Flush any pending terminal audit events (T109a durability lifecycle). */
  flushAudit(): Promise<number>;
  /** Close agent and flush remaining audit records. */
  close(): Promise<void>;

  // ── Provider management parity methods (Spec 013 / Spec 021) ───────────
  addProvider(input: import("./contracts/provider-manager-api.js").AccountInput): Promise<import("./contracts/provider-manager-api.js").SaveResult>;
  removeProvider(id: string, opts?: { force?: boolean }): Promise<import("./contracts/provider-manager-api.js").DeleteResult>;
  setAssignment(purpose: Purpose, tier: Tier | undefined, target: import("./contracts/provider-manager-api.js").AssignmentTarget): Promise<import("./contracts/provider-manager-api.js").SaveResult>;
  clearAssignment(purpose: Purpose, tier?: Tier): Promise<import("./contracts/provider-manager-api.js").SaveResult>;
  getCatalog(): Promise<readonly import("./schemas/inference.js").AvailableModel[]>;
  getAssignments(): import("./schemas/provider-config.js").PurposeModelMap;
  listProviders(): Promise<string[]>;
  reload(): Promise<{ revision: number }>;
  resolve(opts: { purpose: Purpose; tier?: Tier; override?: any }): Promise<any>;
  dispose(): Promise<void>;
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
  provider?: string;
  providerAccount?: string;
  model?: string;
  /**
   * Owner identity. A persisted session may only be resumed by the principal
   * that created it — resumes under a different principalId fail closed.
   */
  principalId?: string;
  /** Arbitrary metadata for backends or consumers (e.g., TTL, apiKeyHash). */
  metadata?: Record<string, unknown>;
}

// ── Skills ────────────────────────────────────────────────────────────

// ── runSeepientServer ─────────────────────────────────────────────────

export interface RunSeepientServerOptions {
  /** Port to listen on (default: SEEPIENT_PORT, PORT, or 7337) */
  port?: number;
  /** Host to bind to (default: "0.0.0.0") */
  host?: string;
  /** Enable CORS headers (default: true) */
  cors?: boolean;
  /** Session TTL in seconds (default: 86400 = 24 hours) */
  sessionTTL?: number;
  /** Injected ProviderRuntime */
  runtime?: import("./contracts/provider-runtime.js").ProviderRuntimeContract;
  /** Injected session persistence backend */
  persist?: PersistenceBackend;
  /** Injected tenant audit store */
  auditStore?: import("./contracts/execution-brokers.js").AuditStore;
  /** Injected tenant policy store */
  policyStore?: import("./contracts/execution-brokers.js").PolicyStore;
  /** Injected tenant capability ledger */
  capabilityLedger?: import("./contracts/capability-ledger.js").CapabilityLedger;
  /** Injected settings manager (structural contract; the concrete SettingsManager satisfies it) */
  settingsManager?: import("./contracts/settings-manager-like.js").SettingsManagerLike;
  /**
   * Whether to start listening immediately.
   * Default: true. Set to false to create the configured http.Server without listening.
   */
  listen?: boolean;
}

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

