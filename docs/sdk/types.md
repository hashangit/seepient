---
title: Types Reference
description: Complete TypeScript types reference for the Seepient Agent SDK.
---

# Types Reference

Complete TypeScript type definitions for the Seepient Agent SDK. All types, interfaces, classes, and factories listed here are exported from `"seepient"`.

```typescript
import type {
  Message,
  GenerateTextOptions,
  GenerateTextResult,
  StreamTextOptions,
  StreamTextResult,
  CreateSeepientOptions,
  Seepient,
  PersistenceBackend,
  AuditStore,
  PolicyStore,
  CapabilityLedger,
} from "seepient";
```

---

## Core Types

### Purpose

Model routing purpose identifiers (Spec 010 / Spec 013):

```typescript
type Purpose =
  | "plan"
  | "text"
  | "coding"
  | "vision"
  | "commit"
  | "image-generation"
  | "video-generation"
  | "tts"
  | "stt"
  | "dreaming"
  | "data"
  | "media.image"
  | "media.speech"
  | "media.transcription"
  | "media.video";
```

### Tier

Model capability tiers:

```typescript
type Tier = "efficient" | "standard" | "complex";
```

### ConsentMode

Controls tool approval behavior across the unified policy pipeline:

```typescript
type ConsentMode = "ask-everything" | "edit-enabled" | "autonomous";
```

| Mode | Behavior |
|---|---|
| `edit-enabled` | Safe reads, workspace writes, and normal tools auto-execute; prompts for high-risk commands and external communications (default) |
| `ask-everything` | Prompts for human approval on all side-effecting operations |
| `autonomous` | Automatically approves all operations within the deployment ceiling |

### ToolRiskCategory

Risk classification for built-in and custom tools:

```typescript
type ToolRiskCategory = "safe" | "edit" | "communications" | "destructive";
```

### Message

```typescript
interface Message {
  /** Unique message identifier. */
  id: string;
  /** Message role. */
  role: "system" | "user" | "assistant" | "tool";
  /** Message text content. */
  content: string;
  /** Tool calls made in this message (assistant role only). */
  toolCalls?: ToolCall[];
  /** Tool call ID this message responds to (tool role only). */
  toolCallId?: string;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
}
```

### ToolCall

```typescript
interface ToolCall {
  /** Unique tool call identifier. */
  id: string;
  /** Tool name, e.g. "web_search", "read_file". */
  name: string;
  /** Arguments passed to the tool. */
  arguments: Record<string, unknown>;
  /** Tool execution result, if available. */
  result?: string;
}
```

### StepResult

```typescript
interface StepResult {
  /** Step type: text generation or tool invocation. */
  type: "text" | "text_delta" | "tool_call";
  /** Generated text content (type: "text" or "text_delta"). */
  content?: string;
  /** Tool call details (type: "tool_call"). */
  toolCall?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    result: string;
    /** Execution time in milliseconds. */
    duration: number;
  };
  /** Unix timestamp in milliseconds. */
  timestamp: number;
}
```

### Usage

```typescript
interface Usage {
  /** Number of tokens in the prompt. */
  promptTokens: number;
  /** Number of tokens in the completion. */
  completionTokens: number;
  /** Total tokens (prompt + completion). */
  totalTokens: number;
  /** Estimated cost in USD. */
  cost: number;
}
```

### CumulativeUsage

```typescript
interface CumulativeUsage {
  /** Total prompt tokens across all requests. */
  totalPromptTokens: number;
  /** Total completion tokens across all requests. */
  totalCompletionTokens: number;
  /** Total estimated cost in USD across all requests. */
  totalCost: number;
  /** Total number of requests made. */
  requestCount: number;
}
```

---

## generateText & streamText Types

### GenerateTextOptions

```typescript
interface GenerateTextOptions {
  /** Model identifier, e.g. "gpt-5.4", "claude-sonnet-4-6-20260320". */
  model?: string;
  /** Feeds the permission pipeline's modelProviderClass audit label. */
  provider?: string;
  /** Purpose routing hint for provider runtime selection. */
  purpose?: Purpose;
  /** Capability tier hint for provider runtime selection. */
  tier?: Tier;
  /** Target provider account identifier. */
  providerAccount?: string;
  /** Injected provider runtime instance. */
  runtime?: ProviderRuntimeContract | ProviderRuntime;
  /** Authenticated principal identity, threaded into audit events. */
  principalId?: string;
  /** Injected audit store for recording action lifecycle events. */
  auditStore?: AuditStore;
  /** Injected policy store for grant snapshots and mutations. */
  policyStore?: PolicyStore;
  /** Injected capability ledger for lease consumption and revocations. */
  capabilityLedger?: CapabilityLedger;
  /** System message prepended to the conversation. */
  systemPrompt?: string;
  /** Tools available: string names, group constants, or custom tool registrations. */
  tools?: (string | UserToolDefinition | AnyToolRegistration)[];
  /** Consent mode controlling tool auto-execution. Default: "edit-enabled". */
  consentMode?: ConsentMode;
  /** Maximum capability ceiling permitted for any execution in this call. */
  deploymentCeiling?: CapabilitySet | Capability[];
  /** Pre-granted capabilities for the calling principal. */
  principalPolicy?: CapabilitySet | Capability[];
  /** Interactive tool approval callback. */
  approveTool?: ApproveToolFn;
  /** Custom approval broker for permission escalation. */
  approvalBroker?: ApprovalBroker;
  /** Optional commit helper override (test/embedder injection). */
  commitHelper?: CommitHelper;
  /** Optional network adapter override with SSRF / IP pinning rules. */
  network?: BrokerNetworkAdapter;
  /** Working directory for file operations and skill discovery. */
  cwd?: string;
  /** Skill names to activate, true for all discovered, or false to disable skills. */
  skills?: string[] | boolean;
  /** Maximum agent loop iterations (tool call rounds). Default: 10. */
  maxSteps?: number;
  /** Sampling temperature (0.0 -- 2.0). */
  temperature?: number;
  /** Maximum tokens in the completion. */
  maxTokens?: number;
  /** Lifecycle callbacks. */
  hooks?: Hooks;
  /** Middleware pipeline functions. */
  middleware?: Middleware[];
  /** Adapter-specific metadata passed to middleware. */
  metadata?: Record<string, unknown>;
  /** Extra config passed to tool handlers. */
  config?: Record<string, unknown>;
  /** Abort controller signal for cancellation. */
  signal?: AbortSignal;
}
```

### GenerateTextResult

```typescript
interface GenerateTextResult {
  /** The final assistant response text. */
  text: string;
  /** Ordered list of all loop iterations. */
  steps: StepResult[];
  /** All tool calls made during execution. */
  toolCalls: ToolCall[];
  /** Token usage and cost. */
  usage: Usage;
  /** Why the loop terminated. */
  finishReason: "stop" | "max_steps" | "error" | "aborted";
  /** Full conversation history for this invocation. */
  messages: Message[];
}
```

### StreamTextOptions

Extends `GenerateTextOptions` with real-time streaming callbacks:

```typescript
interface StreamTextOptions extends GenerateTextOptions {
  /** Called with each text chunk as it arrives. */
  onText?: (delta: string) => void;
  /** Called when the agent invokes a tool. */
  onToolCall?: (tool: {
    name: string;
    args: Record<string, unknown>;
    callId: string;
  }) => void;
  /** Called when a tool finishes execution. */
  onToolResult?: (result: {
    callId: string;
    output: string;
    success: boolean;
  }) => void;
  /** Called for every agent loop step. */
  onStep?: (step: StepResult) => void;
  /** Called if an error occurs during execution. */
  onError?: (error: SeepientError) => void;
}
```

### StreamTextResult

```typescript
interface StreamTextResult {
  /** Async iterator yielding text deltas as they arrive. */
  textStream: AsyncIterable<string>;
  /** Async iterator yielding each agent loop step in actual execution order. */
  steps: AsyncIterable<StepResult>;
  /** Resolves with the complete text when the loop finishes. */
  fullText: Promise<string>;
  /** Resolves with token usage and cost when the loop finishes. */
  usage: Promise<Usage>;
  /** Resolves with the finish reason. */
  finishReason: Promise<string>;
  /** Call to cancel the running loop. */
  abort: () => void;
  /** Returns a Web API Response with SSE body. */
  toResponse: () => Response;
  /** Returns a ReadableStream in SSE wire format. */
  toSSEStream: () => ReadableStream;
}
```

---

## Agent Types (`createSeepient`)

### CreateSeepientOptions

```typescript
interface CreateSeepientOptions {
  /** Model identifier, e.g. "gpt-5.4", "claude-sonnet-4-6-20260320". */
  model?: string;
  /** Feeds the permission pipeline's modelProviderClass audit label. */
  provider?: string;
  /** Target provider account name (persisted and restored with session state). */
  providerAccount?: string;
  /** Purpose routing hint for model resolution. */
  purpose?: Purpose;
  /** Capability tier hint for model resolution. */
  tier?: Tier;
  /** Programmatic provider accounts for isolated in-memory runtimes. */
  providers?: Record<string, any>;
  /** Programmatic purpose-and-tier routing assignments. */
  modelAssignments?: PurposeModelMap;
  /** Injected credential store (e.g. MemoryCredentialStore for isolated runtimes). */
  credentials?: CredentialStore;
  /** Config overlay file path, or ":memory:" for zero-disk isolated instances. */
  overlayFile?: string;
  /** Custom inference adapter or test double. */
  adapter?: InferenceAdapter;
  /** Per-instance model and account override. */
  override?: { providerAccount?: string; model?: string; thinkingLevel?: any };
  /** System prompt prepended to every conversation. */
  systemPrompt?: string;
  /** Tools available: string names, group constants, or custom tool registrations. */
  tools?: (string | UserToolDefinition | AnyToolRegistration)[];
  /** Skill names to activate, true for all, or false to disable skill scanning. */
  skills?: string[] | boolean;
  /** Working directory for file tools and skill discovery. */
  cwd?: string;
  /** Maximum agent loop iterations per call. Default: 10. */
  maxSteps?: number;
  /** Session persistence: path, backend instance, or config object. */
  persist?: string | PersistenceBackend | PersistenceConfig | SessionStore;
  /** Lifecycle callbacks. */
  hooks?: Hooks;
  /** Extra config passed to tool handlers. */
  config?: Record<string, unknown>;
  /** Adapter-specific metadata passed to middleware. */
  metadata?: Record<string, unknown>;
  /** Middleware pipeline functions. */
  middleware?: Middleware[];
  /** Interactive tool approval callback. */
  approveTool?: ApproveToolFn;
  /** Custom approval broker for permission escalation. */
  approvalBroker?: ApprovalBroker;
  /** Consent mode controlling tool auto-execution. Default: "edit-enabled". */
  consentMode?: ConsentMode;
  /** Maximum capability ceiling permitted for any execution. */
  deploymentCeiling?: CapabilitySet | Capability[];
  /** Pre-granted capabilities for the calling principal. */
  principalPolicy?: CapabilitySet | Capability[];
  /** Optional commit helper override for test/embedder injection. */
  commitHelper?: CommitHelper;
  /** Optional network adapter override with SSRF / IP pinning rules. */
  network?: BrokerNetworkAdapter;
  /** Injected provider runtime managing model assignments, credentials, and adapters. */
  runtime?: ProviderRuntimeContract | ProviderRuntime;
  /** Authenticated principal identity, threaded into audit events and capability grants. */
  principalId?: string;
  /** Explicit session identifier (alphanumeric, hyphens, underscores). */
  sessionId?: string;
  /** Injected audit store for recording action lifecycle events. */
  auditStore?: AuditStore;
  /** Injected policy store for grant snapshots and mutations. */
  policyStore?: PolicyStore;
  /** Injected capability ledger for lease consumption and revocations. */
  capabilityLedger?: CapabilityLedger;
}
```

### Seepient

```typescript
interface Seepient {
  /** Active session identifier. */
  readonly sessionId: string;
  /** Send a message and get the full response. Context is preserved. */
  chat(message: string): Promise<AgentResponse>;
  /** Send a message with streaming output. */
  chatStream(message: string, options?: StreamTextOptions): Promise<StreamTextResult>;
  /** Switch the provider account (and optionally model) used for subsequent calls. */
  switchProvider(accountOrModel: string, model?: string): Promise<void>;
  /** Update the system prompt. Replaces the existing system message in history. */
  setSystemPrompt(prompt: string): void;
  /** Update the available tool set by name. */
  setTools(tools: string[]): void;
  /** Abort the currently running chat() or chatStream() call. */
  abort(): void;
  /** Clear conversation history. Keeps the system prompt. */
  clear(): void;
  /** Return a copy of the full conversation history. */
  getHistory(): Message[];
  /** Return cumulative token usage across all calls. */
  getUsage(): CumulativeUsage;
  /** Flush pending terminal audit events (durability lifecycle). */
  flushAudit(): Promise<number>;
  /** Clean up resources, abort running calls, and flush audit records. */
  close(): Promise<void>;

  // ── Provider Management Parity Methods (Spec 013 / Spec 021) ───────────
  /** Programmatically add or update a provider account. */
  addProvider(input: AccountInput): Promise<SaveResult>;
  /** Remove a configured provider account. */
  removeProvider(id: string, opts?: { force?: boolean }): Promise<DeleteResult>;
  /** Set a purpose-and-tier model assignment. */
  setAssignment(purpose: Purpose, tier: Tier | undefined, target: AssignmentTarget): Promise<SaveResult>;
  /** Clear a purpose-and-tier model assignment. */
  clearAssignment(purpose: Purpose, tier?: Tier): Promise<SaveResult>;
  /** Return all available models across configured provider accounts. */
  getCatalog(): Promise<readonly AvailableModel[]>;
  /** Return active purpose-and-tier model assignments. */
  getAssignments(): PurposeModelMap;
  /** List distinct upstream provider names. */
  listProviders(): Promise<string[]>;
  /** Force-reload configuration state from the backing store. */
  reload(): Promise<{ revision: number }>;
  /** Preview how an invocation will route without making a model call. */
  resolve(opts: { purpose: Purpose; tier?: Tier; override?: any }): Promise<any>;
  /** Closes agent, flushes audit logs, and removes all runtime listeners. */
  dispose(): Promise<void>;
}
```

### AgentResponse

```typescript
interface AgentResponse {
  /** The assistant response text. */
  text: string;
  /** Tool calls made during this response. */
  toolCalls: ToolCall[];
  /** Token usage for this request. */
  usage: Usage;
}
```

---

## Custom Tool Trust Models

### AnyToolRegistration

Discriminated union of explicit trust model registrations:

```typescript
type AnyToolRegistration =
  | PreparedToolRegistration
  | BrokerConnectorRegistration
  | TrustedHostToolRegistration
  | LegacyHostToolRegistration;
```

### PreparedToolRegistration

Registered via `preparedTool({ ... })`:

```typescript
interface PreparedToolRegistration {
  kind: "prepared";
  trust: "analyzer";
  definition: ToolDefinition;
  allowedOperationKinds: OperationKind[];
  analyze: (args: unknown, context: ToolAnalysisContext) => Promise<PreparedToolActionDraft>;
}
```

### BrokerConnectorRegistration

Registered via `brokerConnector({ ... })`:

```typescript
interface BrokerConnectorRegistration {
  kind: "broker-connector";
  definition: ToolDefinition;
  connector: string;
  mapping: {
    version: 1;
    operation: string;
    argumentBindings?: Record<string, string>; // JSON Pointer into args
    constants?: Record<string, unknown>;
    secretRefs?: string[];
  };
}
```

### TrustedHostToolRegistration

Registered via `trustedHostTool({ ... })`:

```typescript
interface TrustedHostToolRegistration {
  trust: "host";
  definition: ToolDefinition;
  declaration?: {
    risk?: "safe" | "edit" | "high";
    effects?: Array<
      | { kind: "network-egress"; destinations: string[] }
      | { kind: "secret-use"; secretRefs: string[] }
      | { kind: "model-egress"; dataClasses: string[] }
    >;
  };
  execute: (args: unknown, context: HostToolContext) => Promise<string | ToolResult>;
}
```

### HostToolContext

```typescript
interface HostToolContext {
  signal?: AbortSignal;
  config?: Record<string, unknown>;
  onUpdate?: (progress: { percentage: number; message?: string }) => void;
}
```

---

## Provider Management & Catalog Types

### AccountInput

```typescript
interface AccountInput {
  accountId: string;
  upstreamProvider: string;
  credential: {
    mode: "paste" | "env" | "keychain" | "none";
    keyValue?: string;
    varName?: string;
  };
  baseUrl?: string;
  models?: string[];
}
```

### SaveResult & DeleteResult

```typescript
interface SaveResult {
  ok: boolean;
  message?: string;
  revision?: number;
}

interface DeleteResult {
  ok: boolean;
  message?: string;
  revision?: number;
}
```

### AssignmentTarget

```typescript
interface AssignmentTarget {
  providerAccount: string;
  model: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
}
```

### ManagerState

```typescript
interface ManagerState {
  revision: number;
  accounts: AccountView[];
  assignments: PurposeModelMap;
  models: AvailableModel[];
  purposes: PurposeDef[];
}
```

### ProviderManagerApi

Returned by `createProviderManagerApi(runtime)`:

```typescript
interface ProviderManagerApi {
  getState(): Promise<ManagerState>;
  saveAccount(input: AccountInput): Promise<SaveResult>;
  deleteAccount(id: string, opts?: { force?: boolean }): Promise<DeleteResult>;
  setAssignment(purpose: PurposeId, tier: Tier | null, target: AssignmentTarget): Promise<SaveResult>;
  clearAssignment(purpose: PurposeId, tier: Tier | null): Promise<SaveResult>;
  refreshModels(accountId: string): Promise<RefreshResult>;
  probeAccount(accountId: string): Promise<ProbeResult>;
  resolvePreview(purpose: PurposeId, tier: Tier | null, override?: ModelAssignmentOverride): Promise<ResolutionPreview | UiError>;
}
```

---

## Security, Policy & Store Types (Stateless Workers)

### AuditStore

```typescript
interface AuditStore {
  append(
    event: ActionAuditEvent,
    opts: { idempotencyKey: string },
  ): Promise<"written" | "duplicate">;
  getTerminal(actionId: string): Promise<ActionAuditEvent | undefined>;
}

interface ActionAuditEvent {
  actionId: string;
  runId: string;
  sessionId?: string;
  principalId: string;
  operationKind: string;
  state: "evaluated" | "approved" | "denied" | "executed" | "failed";
  timestamp: number;
  details?: Record<string, unknown>;
}
```

### PolicyStore

```typescript
interface PolicyStore {
  read(workspaceId: string): Promise<PolicySnapshot>;
  compareAndSet(
    workspaceId: string,
    expectedVersion: number,
    next: CapabilitySet,
    actor: DecisionAuthority,
    mutation?: { mutationId: string },
  ): Promise<PolicySnapshot>;
}

interface PolicySnapshot {
  workspaceId: string;
  version: number;
  capabilities: CapabilitySet;
}
```

### CapabilityLedger

```typescript
interface CapabilityLedger {
  load(): Promise<void>;
  consume(envelopeId: string, actionDigest: string): Promise<boolean>;
  revoke(filter: RevokeFilter): Promise<void>;
  isConsumedDigest(actionDigest: string): boolean;
  isRunRevoked(runId: string): boolean;
  isSessionRevoked(sessionId: string): boolean;
}

interface RevokeFilter {
  runId?: string;
  sessionId?: string;
  principalId?: string;
}
```

### CapabilitySet & DecisionAuthority

```typescript
interface CapabilitySet {
  version: 1;
  capabilities: Capability[];
}

type DecisionAuthority = "operator" | "user" | "policy" | "system";

type ApproveToolFn = (params: {
  tool: string;
  args: Record<string, unknown>;
  risk: ToolRiskCategory;
}) => Promise<boolean>;
```

---

## Settings Types

```typescript
type SettingValue = string | number | boolean | null | Record<string, unknown>;

interface SettingEntry {
  key: string;
  category: string;
  description: string;
  value: SettingValue;
  defaultValue: SettingValue;
  type: "string" | "number" | "boolean" | "enum" | "array" | "object";
  enumChoices?: string[];
  scope: "default" | "global" | "project" | "env";
  isSecret?: boolean;
}

class SettingsError extends Error {
  readonly code: "UNKNOWN_KEY" | "INVALID_VALUE" | "READ_ONLY" | "PERSIST_FAILED";
}
```

---

## Session Types

### PersistenceBackend

Standard interface for session storage (metadata-bearing fidelity):

```typescript
interface PersistenceBackend {
  readonly __persistenceBackend: true;
  save(sessionId: string, data: SessionData): Promise<void>;
  load(sessionId: string): Promise<SessionData | null>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<string[]>;
}
```

### SessionData

```typescript
interface SessionData {
  id: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  provider?: string;
  providerAccount?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}
```

### SessionStore (legacy adapter)

```typescript
/** @deprecated Use PersistenceBackend instead */
interface SessionStore {
  save(sessionId: string, messages: Message[]): Promise<void>;
  load(sessionId: string): Promise<Message[] | null>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<string[]>;
}
```

---

## Hooks & Middleware Types

### Hooks

```typescript
interface Hooks {
  beforeToolCall?: (call: { name: string; args: Record<string, unknown> }) => void | Promise<void>;
  afterToolCall?: (result: { name: string; output: string; duration: number }) => void | Promise<void>;
  onStep?: (step: StepResult) => void | Promise<void>;
  onError?: (error: SeepientError) => void | Promise<void>;
  onFinish?: (result: GenerateTextResult) => void | Promise<void>;
}
```

### Middleware

```typescript
type Middleware = (
  ctx: PipelineContext,
  next: () => Promise<void>,
) => Promise<void>;

interface PipelineContext {
  requestId: string;
  messages: Message[];
  provider: unknown;
  model: string;
  toolDefs: unknown[];
  metadata: Record<string, unknown>;
  result?: unknown;
  signal?: AbortSignal;
  startedAt: number;
}
```

---

## Errors

```typescript
class SeepientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
}
```

| Error class | Code | Retryable | When |
|---|---|---|---|
| `ProviderError` | `PROVIDER_ERROR` | `true` | LLM API network error, rate limit |
| `ToolError` | `TOOL_FAILED` | `true` | Tool execution failure |
| `MaxStepsError` | `MAX_STEPS` | `false` | Loop reached `maxSteps` |
| `AbortedError` | `ABORTED` | `false` | Cancelled via AbortSignal |
| `SettingsError` | Various | `false` | Settings schema/persistence failure |
