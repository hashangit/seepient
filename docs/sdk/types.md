---
title: Types Reference
description: Complete TypeScript types reference for the Seepient Agent SDK.
---

# Types Reference

Complete TypeScript type definitions for the Seepient Agent SDK. All types are exported from `"seepient"`.

```typescript
import type { Message, GenerateTextResult, SdkAgent } from "seepient";
```

## Core Types

### ProviderType

```typescript
type ProviderType = "openai" | "anthropic" | "glm" | "openai-compatible";
```

### ConsentMode

Controls tool approval behavior across the unified policy pipeline:

```typescript
type ConsentMode = "ask-everything" | "edit-enabled" | "autonomous";
```

| Mode | Behavior |
|------|----------|
| `edit-enabled` | Safe reads, workspace writes, and normal tools auto-execute; prompts for high-risk commands and external communications (default) |
| `ask-everything` | Prompts for human approval on all side-effecting operations |
| `autonomous` | Automatically approves all operations within the deployment ceiling |

### ToolRiskCategory

Risk classification for built-in and custom tools:

```typescript
type ToolRiskCategory = "safe" | "edit" | "communications" | "destructive";
```

Custom tools default to `"destructive"` when no `risk` field is provided.

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
  type: "text" | "tool_call";
  /** Generated text content (type: "text"). */
  content?: string;
  /** Tool call details (type: "tool_call"). */
  toolCall?: {
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

## generateText Types

### GenerateTextOptions

```typescript
interface GenerateTextOptions {
  /** Model identifier, e.g. "gpt-5.4", "claude-sonnet-4-6-20260320". */
  model?: string;
  /** Feeds the permission pipeline's modelProviderClass audit label. */
  provider?: string;
  /** System message prepended to the conversation. */
  systemPrompt?: string;
  /** Tools available: string names, group constants, or custom tool registrations. */
  tools?: (string | UserToolDefinition | AnyToolRegistration)[];
  /** Enable the unified domain permission pipeline and execution boundary. */
  permissionPipeline?: boolean;
  /** Skill names to activate. */
  skills?: string[];
  /** Maximum agent loop iterations (tool call rounds). Default: 10. */
  maxSteps?: number;
  /** Sampling temperature (0.0 -- 2.0). */
  temperature?: number;
  /** Maximum tokens in the completion. */
  maxTokens?: number;
  /** Zod schema for structured output. */
  output?: unknown;
  /** Lifecycle callbacks. */
  hooks?: Hooks;
  /** Abort controller signal for cancellation. */
  signal?: AbortSignal;
  /** Middleware pipeline functions. */
  middleware?: Middleware[];
  /** Adapter-specific metadata passed to middleware. */
  metadata?: Record<string, unknown>;
  /** Extra config passed to tool handlers. */
  config?: Record<string, unknown>;
  /** Consent mode controlling tool auto-execution. Default: "edit-enabled". */
  consentMode?: ConsentMode;
}
```

### GenerateTextResult

```typescript
interface GenerateTextResult {
  /** The final assistant response text. */
  text: string;
  /** Structured data when output schema is provided and validation succeeds. */
  data?: unknown;
  /** Validation error when output schema is provided and validation fails. */
  error?: { message: string; issues: unknown };
  /** Ordered list of all loop iterations. */
  steps: StepResult[];
  /** All tool calls made during execution. */
  toolCalls: ToolCall[];
  /** Token usage and cost. */
  usage: Usage;
  /** Why the loop terminated. */
  finishReason: "stop" | "length" | "max_steps" | "error";
  /** Full conversation history for this invocation. */
  messages: Message[];
}
```

## streamText Types

### StreamTextOptions

Extends `GenerateTextOptions` with streaming callbacks:

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
  /** Async iterator yielding each agent loop step. */
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

## Agent Types

### AgentCreateOptions

```typescript
interface AgentCreateOptions {
  /** Model identifier. */
  model?: string;
  /** Feeds the permission pipeline's modelProviderClass audit label. */
  provider?: string;
  /** System prompt prepended to every conversation. */
  systemPrompt?: string;
  /** Tools available: string names, group constants, or custom registrations. */
  tools?: (string | UserToolDefinition | AnyToolRegistration)[];
  /** Enable the unified domain permission pipeline and execution boundary. */
  permissionPipeline?: boolean;
  /** Skill names to activate. */
  skills?: string[];
  /** Maximum agent loop iterations. Default: 10. */
  maxSteps?: number;
  /** Consent mode controlling tool auto-execution. Default: "edit-enabled". */
  consentMode?: ConsentMode;
  /** Session persistence: path, backend instance, or config object. */
  persist?: string | PersistenceBackend | PersistenceConfig;
  /** Lifecycle callbacks. */
  hooks?: Hooks;
  /** Middleware pipeline functions. */
  middleware?: Middleware[];
  /** Adapter-specific metadata passed to middleware. */
  metadata?: Record<string, unknown>;
  /** Extra config passed to tool handlers. */
  config?: Record<string, unknown>;
}
```

### SdkAgent

```typescript
interface SdkAgent {
  /** Send a message and get the full response. Context is preserved. */
  chat(message: string): Promise<AgentResponse>;
  /** Send a message with streaming output. */
  chatStream(message: string, options?: StreamTextOptions): Promise<StreamTextResult>;
  /** Switch the provider account (and optionally model) used for subsequent calls; one argument switches the model only. */
  switchProvider(accountOrModel: string, model?: string): Promise<void>;
  /** Update the system prompt. */
  setSystemPrompt(prompt: string): void;
  /** Update the available tool set. */
  setTools(tools: string[]): void;
  /** Abort the currently running chat() or chatStream() call. */
  abort(): void;
  /** Clear conversation history. Keeps the system prompt. */
  clear(): void;
  /** Return a copy of the full conversation history. */
  getHistory(): Message[];
  /** Return cumulative token usage across all calls. */
  getUsage(): CumulativeUsage;
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

## Tool Types

### UserToolDefinition

```typescript
interface UserToolDefinition {
  /** Tool name. Auto-generated if omitted. */
  name?: string;
  /** Description of what the tool does. Used by the LLM for tool selection. */
  description: string;
  /** Zod schema defining the tool's parameters. */
  parameters: unknown;
  /** The function that runs when the LLM calls this tool. */
  execute: (args: unknown, context: ToolContext) => Promise<string | ToolResult>;
}
```

### ToolContext

```typescript
interface ToolContext {
  /** Report progress during long-running operations. */
  onUpdate?: (progress: { percentage: number; message?: string }) => void;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Extra config from the agent or generateText call. */
  config?: Record<string, unknown>;
}
```

### ToolResult

```typescript
interface ToolResult {
  /** Tool output text. */
  output: string;
  /** Whether the tool execution succeeded. */
  success: boolean;
  /** Optional metadata about the execution. */
  metadata?: Record<string, unknown>;
}
```

### ToolDefinition

```typescript
interface ToolDefinition {
  type: "function";
  function: {
    /** Tool name, e.g. "read_file", "web_search". */
    name: string;
    /** Description of what the tool does. Used by the LLM for tool selection. */
    description: string;
    /** JSON Schema defining the tool's parameters. */
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}
```

### ToolModule

```typescript
// Returned by the tool() factory
interface ToolModule {
  /** Tool name. */
  name: string;
  /** Risk category for permission checks. Default: "destructive". */
  risk?: ToolRiskCategory;
  /** Config keys this tool reads from the agent config. */
  configKeys?: string[];
  /** Tool definition for the LLM. */
  definition: ToolDefinition;
  /** Execute function that runs when the LLM calls this tool. */
  handler: (args: any, config?: any) => Promise<string>;
}
```

## Hooks

```typescript
interface Hooks {
  /** Called before each tool execution. */
  beforeToolCall?: (
    call: { name: string; args: Record<string, unknown> },
  ) => void | Promise<void>;

  /** Called after each tool execution completes. */
  afterToolCall?: (
    result: { name: string; output: string; duration: number },
  ) => void | Promise<void>;

  /** Called for every step in the agent loop (text or tool_call). */
  onStep?: (step: StepResult) => void | Promise<void>;

  /** Called when an error occurs. */
  onError?: (error: SeepientError) => void | Promise<void>;

  /** Called when the agent loop finishes. */
  onFinish?: (result: GenerateTextResult) => void | Promise<void>;
}
```

## Error Types

### SeepientError

Base class for all Seepient Agent errors:

```typescript
class SeepientError extends Error {
  /** Machine-readable error code. */
  code: string;
  /** Whether the operation can be retried. */
  retryable: boolean;
}
```

### ProviderError

```typescript
class ProviderError extends SeepientError {
  code: "PROVIDER_ERROR";
  retryable: true;
  /** The provider name that produced the error. */
  provider?: string;
}
```

### ToolError

```typescript
class ToolError extends SeepientError {
  code: "TOOL_FAILED";
  retryable: true;
  /** The tool name that produced the error. */
  tool?: string;
}
```

### MaxStepsError

```typescript
class MaxStepsError extends SeepientError {
  code: "MAX_STEPS";
  retryable: false;
  /** The number of steps that were executed. */
  steps: number;
}
```

### AbortedError

```typescript
class AbortedError extends SeepientError {
  code: "ABORTED";
  retryable: false;
}
```

### Error summary

| Error class     | `code`             | `retryable` | Extra fields    | When                            |
|-----------------|--------------------|--------------|-----------------|---------------------------------|
| `ProviderError` | `PROVIDER_ERROR`   | `true`       | `provider?`     | LLM API failure, rate-limit     |
| `ToolError`     | `TOOL_FAILED`      | `true`       | `tool?`         | Tool execution failure          |
| `MaxStepsError` | `MAX_STEPS`        | `false`      | `steps`         | Agent loop exceeded `maxSteps`  |
| `AbortedError`  | `ABORTED`          | `false`      | *(none)*        | Cancelled via `AbortSignal`     |

## Provider Types

### MultiProviderConfig

```typescript
interface MultiProviderConfig {
  openai?: { apiKey: string; model?: string };
  anthropic?: { apiKey: string; model?: string };
  glm?: { apiKey: string; model?: string };
  "openai-compatible"?: { apiKey: string; baseUrl: string; model?: string };
  /** Default provider when none is specified. */
  default: ProviderType;
}
```

### ProviderConfig

Returned by the `provider()` factory:

```typescript
interface ProviderConfig {
  /** Provider type identifier. */
  type: ProviderType;
  /** API key for authentication. */
  apiKey: string;
  /** Model identifier to use. */
  model: string;
  /** Custom base URL (used by openai-compatible provider). */
  baseUrl?: string;
  /** Request timeout in milliseconds. */
  timeout?: number;
}
```

### ChatOptions

Options passed to the low-level provider `chat()` method:

```typescript
interface ChatOptions {
  /** AbortSignal to cancel in-flight HTTP requests. */
  signal?: AbortSignal;
}
```

### LLMProvider

Low-level provider interface. Implementations wrap specific LLM APIs.

```typescript
interface LLMProvider {
  chat(messages: ProviderMessage[], tools: ToolDefinition[], options?: ChatOptions): Promise<ProviderResponse>;
}
```

## Session Types

### PersistenceBackend

The standard interface for session storage. Implement this for custom backends (Redis, SQLite, etc.):

```typescript
interface PersistenceBackend {
  /** Save session data. Creates or updates. */
  save(sessionId: string, data: SessionData): Promise<void>;
  /** Load session data. Returns null if not found. */
  load(sessionId: string): Promise<SessionData | null>;
  /** Delete a session. */
  delete(sessionId: string): Promise<void>;
  /** List all session IDs. */
  list(): Promise<string[]>;
}
```

### PersistenceConfig

```typescript
interface PersistenceConfig {
  /** Backend type: "file", "memory", or custom registered type. */
  type: string;
  /** Backend-specific options (path, url, etc.). */
  [key: string]: unknown;
}
```

### SessionData

```typescript
interface SessionData {
  /** Session identifier. */
  id: string;
  /** Conversation messages. */
  messages: Message[];
  /** Creation timestamp (Unix ms). */
  createdAt: number;
  /** Last update timestamp (Unix ms). */
  updatedAt: number;
  /** Provider used for this session. */
  provider?: ProviderType;
  /** Model used for this session. */
  model?: string;
  /** Arbitrary metadata (e.g. apiKeyHash for server sessions). */
  metadata?: Record<string, unknown>;
}
```

### SessionStore (deprecated)

Use `PersistenceBackend` instead. The legacy interface is preserved for backward compatibility:

```typescript
/** @deprecated Use PersistenceBackend instead */
interface SessionStore {
  save(sessionId: string, messages: Message[]): Promise<void>;
  load(sessionId: string): Promise<Message[] | null>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<string[]>;
}
```

## Middleware Types

### Middleware

```typescript
type Middleware = (
  ctx: PipelineContext,
  next: () => Promise<void>,
) => Promise<void>;
```

### PipelineContext

Carries all state through the middleware pipeline:

```typescript
interface PipelineContext {
  /** Unique request identifier. */
  requestId: string;
  /** The messages being sent to the provider. */
  messages: Message[];
  /** Resolved provider instance. */
  provider: LLMProvider;
  /** Model name. */
  model: string;
  /** Tool definitions available for this invocation. */
  toolDefs: ToolDefinition[];
  /** Adapter-specific metadata. */
  metadata: Record<string, unknown>;
  /** The result, populated after the agent loop completes. */
  result?: AgentLoopResult;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Timestamp when the pipeline started. */
  startedAt: number;
}
```

### Built-in middleware

```typescript
// Logging — logs request start and response finish
function loggingMiddleware(options?: {
  logRequest?: boolean;
  logResponse?: boolean;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}): Middleware;

// Rate limiting — token bucket per key
function rateLimitMiddleware(options: {
  maxRequests: number;
  windowMs: number;
  keyExtractor?: (ctx: PipelineContext) => string;
}): Middleware;

// Auth — validate identity from context
function authMiddleware(options: {
  validate: (ctx: PipelineContext) => boolean | Promise<boolean>;
  errorMessage?: string;
}): Middleware;
```

## Skill Types

### SkillMetadata

```typescript
interface SkillMetadata {
  /** Unique skill identifier. */
  name: string;
  /** Short description shown to the LLM for skill selection. */
  description: string;
  /** Semantic version. */
  version: string;
  /** Tags for categorization. */
  tags: string[];
  /** Restrict which tools this skill can use. */
  allowedTools?: string[];
}
```

### SkillModelConfig

Per-skill model selection. Used in `SkillFrontmatter.model`:

```typescript
interface SkillModelConfig {
  /** Provider type, e.g. "openai", "anthropic", "glm", "openai-compatible". */
  provider?: string;
  /** Model id or nickname, e.g. "gpt-5.4", "sonnet", "claude-haiku-4-5-20251001". */
  model: string;
}
```

### SkillFrontmatter

All fields a skill author can write in the YAML header of a `SKILL.md` file:

```typescript
interface SkillFrontmatter {
  /** Skill name (required). */
  name: string;
  /** Short description shown to the LLM (required). */
  description: string;
  /** Semantic version. */
  version?: string;
  /** Author name. */
  author?: string;
  /** Tags for categorization. */
  tags?: string[];
  /** Restrict which tools this skill can use. */
  allowedTools?: string[];
  /** Priority for skill resolution (higher wins). */
  priority?: number;
  /** Declared argument names, e.g. ["environment", "service"]. */
  args?: string[];
  /** Preferred provider/model for this skill. */
  model?: SkillModelConfig;
}
```

### Skill

Full skill object returned by the registry. Body is loaded lazily via `getBody()`:

```typescript
interface Skill {
  /** Unique skill identifier. */
  name: string;
  /** Short description. */
  description: string;
  /** Semantic version. */
  version: string;
  /** Author name. */
  author?: string;
  /** Tags for categorization. */
  tags: string[];
  /** Restrict which tools this skill can use. */
  allowedTools?: string[];
  /** Priority for skill resolution. */
  priority: number;
  /** Base path for @path resolution. */
  basePath: string;
  /** Discovery source (built-in, global, local). */
  source: string;
  /** Raw frontmatter from the SKILL.md file. */
  frontmatter: SkillFrontmatter;
  /** Absolute path to SKILL.md for lazy body loading. */
  filePath: string;
}
```

### SkillRegistry

The skill registry interface used to look up and load skills:

```typescript
interface SkillRegistry {
  /** Look up a skill by name. */
  get(name: string): Skill | undefined;
  /** Return all registered skills. */
  getAll(): Skill[];
  /** Return lightweight metadata for all skills. */
  getMetadata(): SkillMetadata[];
  /** Lazily load the skill body text. */
  getBody(name: string): Promise<string | undefined>;
}
```

### TruncationResult

Returned by `limitSkillBody()` when enforcing size limits:

```typescript
interface TruncationResult {
  /** The (possibly truncated) body. */
  body: string;
  /** Whether truncation was applied. */
  truncated: boolean;
  /** Original body size in characters. */
  originalChars: number;
  /** Estimated original token count (chars / 4). */
  originalTokenEstimate: number;
  /** Final body size in characters. */
  finalChars: number;
  /** Estimated final token count (chars / 4). */
  finalTokenEstimate: number;
}
```

### SkillInvocationResult

Returned by `invokeSkill()` with the constructed prompt and provider-switching metadata:

```typescript
interface SkillInvocationResult {
  /** The constructed prompt to send to the agent. */
  prompt: string;
  /** Resolved skill metadata. */
  skill: SkillMetadata;
  /** Whether the skill has a preferred provider that needs switching. */
  providerSwitchNeeded: boolean;
  /** The preferred provider type (if any). */
  preferredProvider?: string;
  /** The preferred model (if any). */
  preferredModel?: string;
}
```

### ProviderSwitcherConfig

Configuration for creating a skill provider switcher:

```typescript
interface ProviderSwitcherConfig {
  /** The current active provider. */
  provider: LLMProvider;
  /** The current active model name. */
  model: string;
  /** Available model configurations keyed by provider type. */
  models: Record<string, { apiKey: string; baseUrl?: string; model: string }>;
}
```

### SkillProviderSwitcher

Temporarily changes the active provider/model based on skill preferences and can restore the original when done:

```typescript
interface SkillProviderSwitcher {
  /** Switch provider if the skill requires it. Returns true if switched. */
  switchIfNeeded(skillResult: SkillInvocationResult): Promise<boolean>;
  /** Restore the original provider/model. */
  restore(): void;
  /** The current active provider. */
  readonly activeProvider: LLMProvider;
  /** The current active model name. */
  readonly activeModel: string;
}
```

### Skill body size constants and functions

```typescript
/** Default maximum skill body size in characters (~8k tokens). */
const DEFAULT_SKILL_BODY_MAX_CHARS = 32_000;

/** Default warning threshold in characters (~2k tokens). */
const DEFAULT_SKILL_BODY_WARN_CHARS = 8_000;

/** Resolved skill body limits from environment variables. */
function getSkillBodyLimits(): {
  maxChars: number;  // SEEPIENT_SKILL_BODY_MAX_CHARS (default: 32000)
  warnChars: number; // SEEPIENT_SKILL_BODY_WARN_CHARS (default: 8000)
};

/** Enforce size limits on a skill body. Fail-soft: never throws. */
function limitSkillBody(
  body: string,
  maxChars?: number,
  warnChars?: number,
): TruncationResult;
```

### buildSkillCatalog

Builds a skill catalog string suitable for appending to the system prompt:

```typescript
function buildSkillCatalog(metadata: SkillMetadata[]): string;
```

### invokeSkill

Central orchestrator for skill invocation. Parses input, looks up the skill, substitutes arguments, resolves `@path` references, and returns a constructed prompt:

```typescript
function invokeSkill(options: {
  input: string;
  registry: SkillRegistry;
  skillsPath?: string;
}): Promise<SkillInvocationResult | null>;
```

### createSkillProviderSwitcher

Creates a switcher that temporarily changes the active provider/model based on skill preferences:

```typescript
function createSkillProviderSwitcher(
  config: ProviderSwitcherConfig,
): SkillProviderSwitcher;
```

## Session Registration

### registerBackend

Register a custom persistence backend for session storage. Built-in backends (`file`, `memory`) are registered automatically:

```typescript
type BackendFactory = (config: PersistenceConfig) => PersistenceBackend;

function registerBackend(type: string, factory: BackendFactory): void;
```

## Related pages

- [generateText()](/sdk/generate-text) -- One-shot execution
- [streamText()](/sdk/stream-text) -- Streaming execution
- [createAgent()](/sdk/create-agent) -- Stateful multi-turn agent
- [Custom Tools](/sdk/custom-tools) -- Building custom tools
- [Hooks](/sdk/hooks) -- Lifecycle callbacks
- [Providers](/sdk/providers) -- Multi-provider configuration
- [Session Persistence](/sdk/session-persistence) -- Session management
