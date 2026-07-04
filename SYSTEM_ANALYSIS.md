# Seepient Agent System Architecture — Complete Analysis

## 1. High-Level Architecture

Seepient Agent follows a three-layer architecture with a single execution engine shared by all adapters:

```
Adapters (CLI, SDK, Server)
    │
    ▼
Core Agent Loop (runAgentLoop)
    │
    ▼
Infrastructure (Providers, Tools, Skills)
```

### Directory Map

```
src/
├── core/                    # 19 files + middleware/ subdirectory
│   ├── agent-loop.ts        # Central execution engine
│   ├── types.ts             # All core type definitions
│   ├── tool-executor.ts     # Tool registry, execution, resolution
│   ├── permission.ts        # Risk-based tool approval matrix
│   ├── hooks.ts             # Safe lifecycle hook executor
│   ├── middleware.ts         # compose(), PipelineContext, Middleware type
│   ├── middleware/           # logging, rate-limit, auth middleware
│   ├── stream-manager.ts    # Push-based streaming queue + SSE
│   ├── session-store.ts     # PersistenceBackend interface + File/Memory backends
│   ├── errors.ts            # SeepientError class hierarchy
│   ├── settings-schema.ts   # 31 dot-key settings definition
│   ├── settings-manager.ts  # Runtime get/set/reset/list with persistence
│   ├── config.ts            # Config file loading, merging, env override
│   ├── provider-env.ts      # Provider env var resolution
│   ├── provider-config.ts   # Provider singleton, mutation, factory
│   ├── provider-resolver.ts # Re-export hub for provider-env + provider-config
│   ├── skill-catalog.ts     # System prompt skill catalog builder
│   ├── skill-invoker.ts     # Skill invocation orchestrator + provider switcher
│   └── message-convert.ts   # Message format translation between provider types
│
├── providers/               # 4 files, ~310 lines
│   ├── types.ts             # LLMProvider interface, ProviderMessage/Response types
│   ├── openai.ts            # OpenAIProvider — wraps OpenAI SDK
│   ├── anthropic.ts         # AnthropicProvider — wraps Anthropic SDK, message translation
│   └── factory.ts           # createProvider() — dynamic import per type, GLM_MODEL_MAP
│
├── tools/                   # 12 built-in tools + 3 shared tools
│   ├── interface.ts         # ToolModule interface
│   ├── index.ts             # Tool module collection, use_skill tool
│   ├── core.ts              # execute_shell_command, read_file, write_file, get_current_datetime
│   ├── email.ts             # send_email (nodemailer/SMTP)
│   ├── search.ts            # web_search (Tavily API)
│   ├── notify.ts            # send_notification (Feishu, DingTalk, WeCom)
│   ├── browser.ts           # read_website (Playwright + Readability)
│   ├── screenshot.ts        # take_screenshot (Playwright)
│   ├── image.ts             # generate_image (DALL-E or compatible)
│   └── prompt-optimizer.ts  # optimize_prompt (OpenAI rewrite)
│
├── skills/                  # File-based plugin system, 7 files
│   ├── types.ts             # Skill, SkillFrontmatter, SkillRegistry, limitSkillBody
│   ├── parser.ts            # YAML frontmatter parsing (custom, no deps)
│   ├── loader.ts            # Multi-source skill discovery
│   ├── registry.ts          # DefaultSkillRegistry with LRU body cache
│   ├── args.ts              # Dynamic argument parsing + template substitution
│   ├── resolver.ts          # @path file reference resolution
│   └── index.ts             # Public API barrel + initializeSkillRegistry
│
├── adapters/
│   ├── cli/                 # Interactive REPL (~15 files)
│   ├── sdk/                 # Programmatic library (6 files)
│   └── server/              # HTTP + WebSocket server (~10 files)
│
└── models-catalog.ts        # Model listings and defaults per provider
```

---

## 2. Core Agent Loop (`src/core/agent-loop.ts`)

The `runAgentLoop()` function is the single, canonical execution engine used by all three adapters. There is no duplicate logic — every adapter constructs `AgentLoopOptions` and delegates here.

### Two-Layer Architecture

```
runAgentLoop(options)
  ├─ If middleware present → compose(middleware)(ctx, executeLoop)
  └─ If no middleware      → executeLoop(options) directly
```

### `executeLoop()` — The Core Iteration

1. **System prompt injection**: Prepends `systemPrompt` and appends `skillCatalog` to system message
2. **Main loop** (up to `maxSteps` iterations):
   - **Abort check**: Returns `"aborted"` if signal is set
   - **Provider resolution**: If `providerFactory` exists (skill-driven switching), resolves a fresh provider/model
   - **Call LLM**: Converts messages to provider format, calls `provider.chat()`
   - **Text response**: If text returned, records `StepResult`, fires `hooks.onStep()`
   - **Tool calls**: If `tool_calls[]` returned, for each:
     - Permission check via matrix + `approveTool` callback
     - Execute via `executeTool()`, push result message
     - Fire `hooks.beforeToolCall()` / `hooks.afterToolCall()`
     - Continue loop
   - **No tool calls**: `finishReason = "stop"`, break
3. **Usage calculation**: Token counts estimated from character counts (chars ÷ 4)

### Key Configuration

| Option | Type | Default |
|--------|------|---------|
| provider | `LLMProvider` | Required |
| model | `string` | Required |
| messages | `Message[]` | Required |
| toolDefs | `ToolDefinition[]` | Required |
| systemPrompt | `string` | Optional |
| skillCatalog | `string` | Optional |
| maxSteps | `number` | 10 (SDK), 30 (CLI), 5 (Server) |
| hooks | `HookExecutor` | Optional (no-op) |
| signal | `AbortSignal` | Optional |
| approveTool | `ApproveToolFn` | Optional |
| permissionLevel | `PermissionLevel` | `"moderate"` |
| autoConfirm | `boolean` | `false` |
| middleware | `Middleware[]` | Optional |
| providerFactory | `() => Promise<{provider, model}>` | Optional (skill switching) |
| onStep | `(step: StepResult) => void` | Optional |

---

## 3. Provider System (`src/providers/`)

4 providers behind a single `LLMProvider` interface. All non-streaming — streaming is handled above via `StreamManager`.

### The `LLMProvider` Interface

```typescript
interface LLMProvider {
  chat(messages: ProviderMessage[], tools: ToolDefinition[], options?: ChatOptions): Promise<ProviderResponse>;
}

interface ProviderResponse {
  content?: string;           // Text content
  tool_calls?: ProviderToolCall[];  // Tool invocations
}
```

### Provider Types

| Type | Class | Base URL | Shared With |
|------|-------|----------|-------------|
| `openai` | `OpenAIProvider` | `api.openai.com/v1` | — |
| `openai-compatible` | `OpenAIProvider` | Custom `baseUrl` | Same class |
| `anthropic` | `AnthropicProvider` | Default Anthropic API | — |
| `glm` | `AnthropicProvider` | `api.z.ai/api/anthropic` | Same class, aliased models |

### GLM Model Aliasing (`factory.ts`)

```
haiku  → glm-4.5-air
sonnet → glm-4.7
opus   → glm-5.1
```

### OpenAI Provider Details

- Casts `ProviderMessage[]` directly to OpenAI SDK message format (identical shapes)
- Casts `ToolDefinition[]` to `ChatCompletionTool[]`
- Calls `client.chat.completions.create()` — **no streaming**
- Filters tool calls to `type === 'function'` only
- Passes `AbortSignal` through to SDK

### Anthropic Provider Details

- **System messages**: Extracted from message array and sent as separate `system` parameter
- **Message translation**: OpenAI format → Anthropic content blocks
  - `assistant` + `tool_calls[]` → content array with `tool_use` blocks, `JSON.parse(args)`
  - `tool` (role) → `user` role with `tool_result` content blocks
- **Tool translation**: `function.parameters` → `input_schema`
- **Hardcoded `max_tokens: 16384`** for all calls

### Provider Resolution Chain

```
CLI flag (--provider)
  → LLM_PROVIDER env var
    → SEEPIENT_PROVIDER env var (legacy)
      → config.provider (setting.json)
        → 'openai' (default)
```

Per-provider env vars:
- `OPENAI_API_KEY` → openai
- `ANTHROPIC_API_KEY` → anthropic
- `GLM_API_KEY` → glm
- `OPENAI_COMPAT_API_KEY` + `OPENAI_COMPAT_BASE_URL` → openai-compatible
- Legacy: `SEEPIENT_API_KEY`, `OPENAI_BASE_URL` (with deprecation warnings)

### Factory Pattern

```typescript
async function createProvider(config: ProviderConfig): Promise<LLMProvider> {
  switch (config.type) {
    case 'openai':              → new OpenAIProvider(apiKey, model, 'https://api.openai.com/v1')
    case 'openai-compatible':   → new OpenAIProvider(apiKey, model, config.baseUrl)
    case 'anthropic':           → new AnthropicProvider(apiKey, model)
    case 'glm':                 → new AnthropicProvider(apiKey, aliasModel, { baseURL, timeout })
  }
}
```

Dynamic imports prevent unused provider SDKs from loading into memory.

---

## 4. Tool Execution System

A registry-based plugin architecture with 12 built-in tools, risk categories, and a permission matrix.

### The `ToolModule` Interface

```typescript
interface ToolModule {
  name: string;                        // Display name
  configKeys?: string[];               // Settings keys needed
  risk?: ToolRiskCategory;             // "safe" | "edit" | "communications" | "destructive"
  definition: ToolDefinition;          // OpenAI function definition
  handler: (args: any, config?: any) => Promise<string>;
}
```

### Tool Registry (`src/core/tool-executor.ts`)

Single in-memory array initialized with all built-in tools:
- `getAllToolDefinitions()` — returns just the function schemas (for LLM)
- `getAllToolModules()` — returns full modules (for permission lookups)
- `registerTool(module)` — adds custom tools
- `tool()` factory — converts `UserToolDefinition` to `ToolModule`

### All 12 Built-in Tools

| # | Function Name | Risk | Description |
|---|--------------|------|-------------|
| 1 | `execute_shell_command` | destructive | Executes shell commands via `child_process.exec` |
| 2 | `read_file` | safe | Reads file contents from disk |
| 3 | `write_file` | edit | Writes content to a file (overwrites) |
| 4 | `get_current_datetime` | safe | Returns current date/time in structured JSON |
| 5 | `optimize_prompt` | safe | Uses OpenAI to rewrite/optimize prompts |
| 6 | `send_email` | communications | Sends email via SMTP (nodemailer) |
| 7 | `web_search` | safe | Searches the web via Tavily API |
| 8 | `send_notification` | communications | Sends to IM bots (Feishu, DingTalk, WeCom) |
| 9 | `read_website` | safe | Reads website content (Playwright + Readability) |
| 10 | `take_screenshot` | safe | Captures screenshots via Playwright |
| 11 | `generate_image` | edit | Generates/edits images via DALL-E or compatible |
| 12 | `use_skill` | safe | Loads and activates a skill from the registry |

### Tool Groups

- **CORE**: `execute_shell_command`, `read_file`, `write_file`, `get_current_datetime`
- **COMM**: `send_email`, `web_search`, `send_notification`
- **ADVANCED**: `read_website`, `take_screenshot`, `generate_image`, `optimize_prompt`, `use_skill`

### `resolveTools(inputs?)`

Converts a mixed array of tool references into deduplicated `ToolDefinition[]`:
- `"all"` → all 12 built-in tools
- `"core"` / `"comm"` / `"advanced"` → the named group
- A built-in tool name string → looked up from registry (throws if not found)
- A `UserToolDefinition` object → converted to a module via `tool()` factory

### Risk Categories & Permission Matrix

4 risk categories: `safe` → `edit` → `communications` → `destructive`

3 permission levels:

| Level | safe | edit | communications | destructive |
|-------|------|------|----------------|-------------|
| **strict** | auto | ask | ask | ask |
| **moderate** (default) | auto | auto | auto | ask |
| **permissive** | auto | auto | auto | auto |

`resolvePermissionLevel()` priority: CLI flag > env var > config file > default ("moderate")

### Full Tool Execution Flow

```
1. LLM returns tool_calls[]
2. agent-loop checks risk category via getToolRiskCategory()
3. checkToolPermission(level, risk) → "auto" or "ask"
4. If "auto" or autoConfirm=true → executeTool() directly
5. If "ask" → approveTool callback (CLI inquirer, WS round-trip, SDK callback)
6. executeTool(name, args, config) → handler(args, config) → string result
7. Tool result appended as role:"tool" message to conversation
8. Loop continues — LLM sees tool result in next chat() call
```

Tool execution failures are caught per-tool — error messages become text results. The LLM sees the error and can self-correct. A single tool failure never terminates the agent loop.

---

## 5. Skill System (`src/skills/`)

File-based plugin system with YAML frontmatter. Skills are discovered from multiple sources, bodies are lazy-loaded, and `@path` references are inlined.

### Skill File Format

```markdown
---
name: code-review
description: Review code for bugs and style issues
version: 1.0.0
tags: [code, review]
allowedTools: [read_file, execute_shell_command]
model:
  provider: openai
  model: gpt-5.4
args: [file, language]
---

# Code Review Skill

Review the file $1 written in $2...
```

### SkillFrontmatter Schema

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Skill identifier (required) |
| `description` | string | What the skill does (required) |
| `version` | string | Semantic version |
| `author` | string | Author name |
| `tags` | string[] | Categorization |
| `allowedTools` | string[] | Tools this skill is allowed to use |
| `priority` | number | Priority for overwrite resolution |
| `args` | string[] | Declared argument names |
| `model` | `{ provider?, model }` | Preferred model for this skill |

### Skill Discovery (`src/skills/loader.ts`)

Priority (last wins):
1. Built-in skills (`<package>/skills/`)
2. `/mnt/skills` (Docker volume mount)
3. `.seepient/skills/` (project local)
4. `SEEPIENT_SKILLS_PATH` env var (colon-separated)

Skills are loaded in **reverse priority order** so higher-priority sources overwrite lower ones. The `priority` field in frontmatter allows fine-grained control.

### Lazy Body Loading (`src/skills/registry.ts`)

- **Discovery**: `parseFrontmatter()` extracts YAML frontmatter only — discards body text
- **Invocation**: `getBody()` loads the full file from disk on demand
- **LRU cache**: 5-entry cache for frequently used skills
- **Eviction**: Oldest entry evicted when cache exceeds 5

### Body Size Limits (`src/skills/types.ts`)

Three-layer defense:
1. **Load-time warning**: If body > 8,000 chars, warn to console
2. **Injection-time truncation**: `limitSkillBody()` truncates at 32,000 chars with a clear marker
3. **Cumulative cap**: `@path` resolver limits total resolved content to 2MB

Configurable via `SEEPIENT_SKILL_BODY_MAX_CHARS` and `SEEPIENT_SKILL_BODY_WARN_CHARS`.

### Argument Substitution (`src/skills/args.ts`)

Template variables in skill bodies:
- `$1`, `$2`, ..., `$N` — positional arguments
- `$ALL` — all arguments as a single string
- `$COUNT` — number of arguments
- `$FIRST` — first argument (alias for `$1`)
- `$LAST` — last argument

Quoted strings in user input are respected for multi-word arguments.

### @Path Resolution (`src/skills/resolver.ts`)

Supports three patterns:
- `@path/to/file` — relative to project root
- `@seepient_documents/file` — resolves to `~/seepient_documents/file`
- `@~/path/to/file` — explicit home directory

Security: Path traversal prevention — only allows access within project root, `~/seepient_documents`, and `~/.seepient`. Per-file max 1MB, max 10 references, cumulative 2MB total. Files are inlined with code block formatting.

### Skill Invocation Flow (`src/core/skill-invoker.ts`)

```
User input "/skill-name args"
  → parseInvocation(input) → { skillName, args }
  → Registry lookup → skill metadata
  → getBody(name) → lazy load from disk
  → substituteArgs(body, args) → replace $1, $2, ...
  → resolveReferences(resolvedQuery) → inline @paths
  → limitSkillBody(substitutedBody) → truncate if needed
  → Return { prompt, skill, providerSwitchNeeded, preferredProvider, preferredModel }
```

### Skill Catalog (`src/core/skill-catalog.ts`)

`buildSkillCatalog()` generates a system prompt appendix listing all available skills with descriptions and tags. Injected into the system message by `runAgentLoop()`.

### Skill Provider Switching (`src/core/skill-invoker.ts`)

`createSkillProviderSwitcher()` captures the original provider/model and can temporarily switch based on skill preferences:
```typescript
const switcher = createSkillProviderSwitcher({ provider, model, models });
const switched = await switcher.switchIfNeeded(skillResult);
try { await agent.chat(skillResult.prompt); }
finally { if (switched) switcher.restore(); }
```

Graceful degradation — if provider creation fails, `switchIfNeeded()` returns `false`.

---

## 6. Adapters

All three adapters converge on `runAgentLoop()`. The agent loop has no knowledge of terminals, HTTP, WebSockets, or SDK return types.

### CLI Adapter (`src/adapters/cli/`)

Interactive REPL with Commander.js setup.

**Entry flow:**
```
seepient chat [query]
  → Commander parses flags
  → loadMergedConfig() (global + local JSON, env overrides)
  → createProvider() → LLMProvider
  → new Agent(provider, model, config)
  → agent.initializeSkills()
  → REPL loop (readline) or single-shot (--no-interactive)
```

**REPL features:**
- Slash commands: `/help`, `/clear`, `/exit`, `/compact`, `/skills`, `/models`, `/settings`, `/setup`
- ESC key interrupt: sets stdin to raw mode, listens for `\x1b`, calls `agent.abort()`
- Tool approval: inquirer prompts with ESC suspended during prompts
- `--headless` / `--yes` / `--docker`: bypasses all permission checks (`autoConfirm=true`)
- Permission flags: `--yolo` (permissive), `--moderate`, `--strict`
- `/compact`: calls `runAgentLoop(maxSteps=1, toolDefs=[])` to summarize conversation, replaces history

### SDK Adapter (`src/adapters/sdk/`)

Programmatic library exposing three functions:

**`generateText(prompt, options?)`** — Stateless one-shot:
```typescript
const result = await generateText("What is the weather?", {
  provider: "openai",
  tools: ["core", customTool],
  maxSteps: 10,
});
// result.text, result.toolCalls, result.usage, result.finishReason
```

**`streamText(prompt, options?)`** — Stateless streaming:
```typescript
const stream = await streamText("Explain...", {
  onText: (delta) => process.stdout.write(delta),
  onToolCall: (call) => console.log("Tool:", call.name),
});
// stream.textStream (AsyncIterable<string>)
// stream.steps (AsyncIterable<StepResult>)
// stream.fullText (Promise<string>)
// stream.usage (Promise<Usage>)
// stream.toResponse() → SSE Response
// stream.toSSEStream() → ReadableStream
```

**`createAgent(options?)`** — Stateful persistent agent:
```typescript
const agent = createAgent({
  provider: "openai",
  systemPrompt: "You are a helpful assistant.",
  tools: ["core"],
  persist: "~/.seepient/sessions/my-agent",
});
const response = await agent.chat("Hello");
// agent.chatStream(), agent.switchProvider(), agent.clear(), agent.getHistory()
```

Session persistence: optional file, memory, or custom `PersistenceBackend`. Messages saved after each `chat()`/`chatStream()` call.

### Server Adapter (`src/adapters/server/`)

HTTP + WebSocket standalone server on port 7337.

**REST Endpoints:**
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/v1/health` | none | Status, version, uptime |
| GET | `/v1/models` | agent:read | Models grouped by provider |
| GET | `/v1/skills` | agent:read | Loaded skill metadata |
| POST | `/v1/chat` | agent:run | One-shot text generation |
| GET | `/v1/sessions/:id` | agent:read | Get session by ID |
| GET/PATCH | `/v1/settings` | agent:read/admin | Settings CRUD |
| POST/PATCH/DELETE | `/v1/providers` | admin | Provider management |

**WebSocket protocol:**
- Connect: `ws://host:7337/ws?token=sk_seepient_...`
- Messages: `chat`, `abort`, `tool_approval_response`, `resume`, `reconnect`, `switch_provider`, `list_models`, `list_skills`, `ping`, settings/providers CRUD
- Tool approval: WS round-trip with 30-second timeout, defense-in-depth checks (origin connection, tool name match, expiry)
- Auth: API key validated on upgrade, `401` if invalid

**Sessions:** `ServerSessionManager` with TTL (24h absolute, 30min inactivity), per-key concurrency limit (5), periodic cleanup (5min), constant-time ownership verification (`crypto.timingSafeEqual`).

**API Keys:** Format `sk_seepient_*`, validated via SHA-256 hash, scopes: `agent:run`, `agent:read`, `admin`.

### Adapter Comparison

| Dimension | CLI | SDK | Server |
|-----------|-----|-----|--------|
| **Entry** | `seepient chat [query]` | `generateText()`, `streamText()`, `createAgent()` | HTTP/WS on port 7337 |
| **State** | Mutable `Agent` class | Stateless (gen/stream) or Stateful (agent) | Sessions via ServerSessionManager |
| **Output** | Console (chalk, ora spinner) | Returned objects, AsyncIterables, SSE | JSON (REST), WS messages |
| **Tool Approval** | inquirer prompts | User-supplied callback | WS round-trip (30s timeout) |
| **Interrupt** | ESC key → abort | `signal` or `.abort()` | WS `abort` message |
| **Max Steps Default** | 30 | 10 | 10 |
| **Streaming** | No (inline prints) | `StreamManager` → SSE/Response | WS text/tool_call/done messages |
| **Persistence** | Implicit in `Agent.messages[]` | Optional via `persist` | ServerSessionManager (file + TTL) |

---

## 7. Middleware System (`src/core/middleware.ts` + `src/core/middleware/`)

A composable chain that wraps the agent loop using the classic `(ctx, next) => Promise<void>` pattern.

### Core Types

```typescript
interface PipelineContext {
  requestId: string;
  messages: Message[];
  provider: LLMProvider;
  model: string;
  toolDefs: ToolDefinition[];
  metadata: Record<string, unknown>;
  result?: AgentLoopResult;
  signal?: AbortSignal;
  startedAt: number;
}

type Middleware = (ctx: PipelineContext, next: () => Promise<void>) => Promise<void>;
```

### `compose()` — Recursive Onion

```
compose([auth, rateLimit, logging]) → (ctx, finalHandler)
```

```
dispatch(0) → auth(ctx, next)
                ├─ validate(ctx)
                ├─ await next() → rateLimit(ctx, next)
                │                   ├─ check bucket → throw if empty
                │                   └─ await next() → logging(ctx, next)
                │                                       ├─ log start
                │                                       ├─ await next() → finalHandler (agent loop)
                │                                       └─ log response
                └─ return
```

Errors thrown by middleware are caught by `runAgentLoop` and returned as structured `AgentLoopResult` with `finishReason: "error"`.

### Built-in Middleware Factories

**`loggingMiddleware()`** — Innermost. Logs request start, then response with finish reason, steps, tokens, duration.

**`rateLimitMiddleware({ maxRequests, windowMs, keyExtractor })`** — Token bucket algorithm, per-key. Throws `SeepientError("RATE_LIMITED")` before loop runs.

**`authMiddleware({ validate })`** — Pre-loop validation. Throws `SeepientError("UNAUTHORIZED")` if `validate(ctx)` returns false.

---

## 8. Session & Persistence System

Three-layer architecture:

```
ServerSessionManager (TTL, concurrency, ownership)
    → PersistenceBackend interface (abstract contract)
        → FilePersistenceBackend | MemoryPersistenceBackend
```

### `PersistenceBackend` Interface

```typescript
interface PersistenceBackend {
  save(id: string, data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  delete(id: string): Promise<void>;
  list(): Promise<string[]>;
}

interface SessionData {
  id: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  provider?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}
```

### Registry & Factory

```typescript
registerBackend("redis", myRedisFactory);
const backend = createPersistenceBackend({ type: "redis", url: "..." });
```

Built-in: `"file"` (JSON files at `~/.seepient/sessions/`) and `"memory"` (Map-based).

### FilePersistenceBackend

- Each session as `{sessionId}.json` at configurable path
- `createdAt` preserved on updates (reads existing file first)
- Session ID validation (`/^[a-zA-Z0-9-]+$/`) prevents path traversal
- Atomic writes: temp file + rename
- `delete()` swallows `ENOENT`

### MemoryPersistenceBackend

- `Map<string, SessionData>` backing store
- Same semantics as file backend (createdAt preservation, merge)
- Used in tests and for ephemeral sessions

### ServerSessionManager

Wraps any `PersistenceBackend` with:
- **TTL**: 24h absolute, 30min inactivity (configurable)
- **Per-key concurrency**: max 5 sessions per API key
- **Periodic cleanup**: every 5 minutes
- **Ownership verification**: `crypto.timingSafeEqual` for API key hash comparison
- **Hot cache**: sessions in memory, backend for rehydration on restart

### SDK Usage

`createAgent({ persist: "~/sessions/my-bot" })` — auto-creates file backend, loads existing sessions on creation, saves after each `chat()` call.

---

## 9. Streaming System (`src/core/stream-manager.ts`)

`StreamManager` bridges non-streaming provider calls into streaming UI/SSE. Single implementation shared by `streamText()` and `chatStream()`.

### Push-Based Queue Architecture

```
Producer (agent loop)                    Consumer (AsyncIterable / SSE)
enqueueText(delta)  ──► textQueue[]  ──► textStream (AsyncIterable<string>)
enqueueStep(step)   ──► stepQueue[]  ──► stepsStream (AsyncIterable<StepResult>)
```

### Backpressure via Resolvers

- Each queue has a resolver promise
- Consumer parks on `await new Promise(r => { self.textResolver = r })` when queue empty
- Producer pushes data and calls resolver to wake consumer
- No polling, no busy-waiting

### Promise-Based Final Values

| Promise | When resolved | What it holds |
|---------|---------------|---------------|
| `fullText` | `resolveText(text)` | Full concatenated text |
| `usage` | `resolveUsage(usage)` | Token usage + cost |
| `finishReason` | `resolveFinish(reason)` | `"stop"`, `"max_steps"`, `"error"` |

### SSE Generation

`toSSEStream()` returns a `ReadableStream<Uint8Array>` emitting:
```
event: text         { delta: "Hello" }
event: text         { delta: " world" }
event: tool_call    { callId, name, args }
event: tool_result  { callId, output, success }
event: done         { usage, finishReason }
```

`toResponse()` wraps this in a Web API `Response` with SSE headers.

### Bridging Strategy

Even though providers return full text (not deltas), the `onStep` callback feeds complete text chunks into the queue as they arrive from each loop iteration. The SSE consumer sees these as discrete events. If providers add true delta streaming in the future, the same queue/consumer infrastructure works without changes.

---

## 10. Hooks System (`src/core/hooks.ts`)

Safety wrapper around user-supplied lifecycle callbacks.

### Hook Interface

```typescript
interface Hooks {
  beforeToolCall?: (call: { name: string; args: Record<string, unknown> }) => void | Promise<void>;
  afterToolCall?:  (result: { name: string; output: string; duration: number }) => void | Promise<void>;
  onStep?:         (step: StepResult) => void | Promise<void>;
  onError?:        (error: SeepientError) => void | Promise<void>;
  onFinish?:       (result: GenerateTextResult) => void | Promise<void>;
}
```

### Safe Executor (`createHookExecutor`)

Every hook method is wrapped in a `run()` helper that:
1. Returns early if hook is missing (no-op)
2. `await`s both sync and async hooks
3. Catches errors, logs them, **never rethrows**

Hook errors cannot crash the agent loop.

### Lifecycle Points in Agent Loop

| Hook | Fires When |
|------|-----------|
| `onError` | Provider resolution or API call fails |
| `onStep` | Text response received from model |
| `beforeToolCall` | Before each tool execution |
| `afterToolCall` | After tool result recorded |
| `onStep` | After tool result recorded (tool_call step) |
| `onFinish` | Called by SDK adapter wrapper (not in agent loop itself) |

---

## 11. Settings & Configuration System

Schema-driven, multi-layer merge with atomic persistence.

### Settings Schema (`src/core/settings-schema.ts`)

31 dot-key settings across 5 categories:
- **providers**: API keys, models, base URLs for all 4 provider types
- **permissions**: `autoConfirm`, `permissionLevel`
- **tools**: SMTP, Tavily, image generation, browser settings
- **notifications**: Feishu, DingTalk, WeCom webhooks
- **skills**: Reserved for future use (body size limits, debug flag)

Each setting has: `type`, `secret` (masking), `default`, `restartRequired`, `envVar`. Note: the `skills` category is currently empty — settings are reserved for future use.

### Settings Manager (`src/core/settings-manager.ts`)

Single source of truth for all settings I/O:

- **`get(dotKey)`**: Resolves via config path, masks secrets, determines origin (env/project/global/default)
- **`set(dotKey, value)`**: Validates type, writes to appropriate config file atomically (temp file + rename)
- **`reset(dotKey)`**: Removes key from config, falls back to default
- **`resetAll()`**: Clears config file, rebuilds from env vars only
- **`onChange(callback)`**: Event listeners for settings changes

Atomic writes with backup (`.bak`), secure permissions (`0o600`).

### Config Loading (`src/core/config.ts`)

Priority (highest to lowest):
1. Environment variables
2. Project local config (`.seepient/setting.json`)
3. Global config (`~/.seepient/setting.json`)
4. Provider singleton (`configureProviders()`)
5. Schema defaults

Legacy format auto-migration: top-level `apiKey` → nested `models["openai-compatible"]`.

### Provider Config (`src/core/provider-config.ts`)

Runtime singleton for provider management:
- `configureProviders(config)` — set all providers
- `addProvider(type, config)` — add/replace a provider
- `updateProviderConfig(type, updates)` — partial update
- `removeProvider(type)` — remove (rejects if last)
- `getProvider(type?)` → `{ provider: LLMProvider, model: string }`
- Persists to `~/.seepientrc.json`

Provider env vars (`provider-env.ts`) handle per-type key resolution with legacy fallbacks.

---

## 12. Error Handling System

### The `SeepientError` Hierarchy

```
SeepientError (base: message, code, retryable)
├── ProviderError  — code: "PROVIDER_ERROR", retryable: true, +provider
├── ToolError      — code: "TOOL_FAILED",    retryable: true, +tool
├── MaxStepsError  — code: "MAX_STEPS",      retryable: false, +steps
└── AbortedError   — code: "ABORTED",        retryable: false
```

### Error Bridging: `toSeepientError()`

Normalizes arbitrary thrown values into proper `SeepientError` instances:
```typescript
function toSeepientError(err: unknown, code: string): SeepientError {
  const message = err instanceof Error ? err.message : String(err);
  switch (code) {
    case "PROVIDER_ERROR": return new ProviderError(message);
    case "TOOL_FAILED":    return new ToolError(message);
    default:              return new SeepientError(message, code, code === "PROVIDER_ERROR");
  }
}
```

### Error Propagation Path

```
Provider SDK throw (network/auth/rate-limit)
  → agent-loop catch block
    → toSeepientError(err, "PROVIDER_ERROR") → ProviderError (retryable=true)
    → hooks.onError(seepientErr) — fire-and-forget
    → AgentLoopResult.error populated → break loop
  → Adapter receives
    → CLI: chalk.red() to console
    → SDK: returned in AgentResponse or streamed via onError callback
    → REST: JSON { error: { code, message } } with 500/502
    → WS: { type: "error", code, retryable, message }
```

### Key Design Decisions

- **Provider errors are terminal to the loop** — caught, wrapped, loop breaks
- **Tool errors are non-terminal** — caught per-tool, error string becomes tool result, LLM can self-correct
- **Abort and max-steps are clean exits** — not errors, different `finishReason`
- **Hooks never crash the main flow** — errors caught and swallowed

---

## 13. Data Flow: Complete Request Lifecycle

### CLI Chat Request

```
User types "What is the weather?"
  → repl.ts:runChat() loads config, resolves provider
  → agent.chat(input) pushes user message
  → runAgentLoop({
        provider, model, messages,
        toolDefs: getAllToolDefinitions(),  // all 12 tools
        maxSteps: 30,
        signal (ESC), approveTool (inquirer),
        permissionLevel (from flags/config),
        onStep: (step) => { print to console }
    })
  → executeLoop():
      Step 1: provider.chat() → text "The weather is..."
        → onStep → console.log("Seepient Agent: The weather is...")
        → no tool_calls → finishReason="stop" → break
  → Spinner stops, returns to REPL prompt
```

### SDK StreamText Request

```
streamText("Write a poem", { onText: log, tools: ["core"] })
  → getProvider() → { provider, model }
  → resolveTools(["core"]) → 4 tool definitions
  → new StreamManager()
  → Background IIFE:
      runAgentLoop({
        provider, model, messages,
        toolDefs: [4 core tools],
        maxSteps: 10,
        onStep: (step) => {
          if text → stream.enqueueText(step.content)
          stream.enqueueStep(step)
        }
      })
      → On complete: stream.resolveText(), stream.resolveUsage(), stream.complete()
  → Immediately returns { textStream, steps, fullText, usage, toResponse() }
  → Consumer reads textStream async iterable, receives deltas as loop runs
```

### Server WS Chat Request

```
WS client sends: { type: "chat", id: "msg_1", message: "Deploy to prod" }
  → ws-handlers.ts:handleChatMessage()
    → ack sent back
    → Create session if needed
    → abortController = new AbortController()
    → approveTool = createServerApproveTool(ws)
        // Sends tool_approval_request to client via WS
        // Waits for tool_approval_response (30s timeout)
    → serverStreamText({
        message, model, provider, tools,
        permissionLevel (capped),
        onText: delta → safeSend({ type: "text", delta }),
        onToolCall: call → safeSend({ type: "tool_call", ... }),
        onToolResult: result → safeSend({ type: "tool_result", ... }),
        onDone: result → safeSend({ type: "done", ... })
                           + add to session
    })
  → runAgentLoop() → executeLoop()
      Step 1: provider.chat() → tool_calls: [execute_shell_command("kubectl deploy")]
        → Permission: risk=destructive, level=moderate → "ask"
        → approveTool callback fires → WS: { type: "tool_approval_request", callId, name, args }
        → Client responds: { type: "tool_approval_response", callId, approved: true }
        → executeTool("execute_shell_command", { command: "kubectl deploy" })
        → Output: "Deployment successful"
        → SafeSend({ type: "tool_result", callId, output })
        → Continue loop
      Step 2: provider.chat() → text "Deployment completed..."
        → SafeSend({ type: "text", delta: "Deployment completed..." })
        → No tool_calls → finishReason="stop"
      → SafeSend({ type: "done", usage, finishReason })
```

---

## 14. Key Architectural Properties

- **Single execution engine**: All three adapters (CLI, SDK, Server) delegate to `runAgentLoop()`. No duplicated loop logic.
- **Transport-agnostic core**: The agent loop has zero knowledge of terminals, HTTP, WebSockets, or SDK return types.
- **Non-streaming providers**: Both OpenAI and Anthropic providers do non-streaming calls. Streaming illusion is created by the `StreamManager` at the adapter level.
- **Dynamic provider imports**: Only the provider being used is loaded into memory via `await import()`.
- **Fail-safe hooks**: Hook errors are caught and logged; they never crash the agent loop.
- **Safe tool permission defaults**: Unknown tools default to "destructive" risk; unknown permission levels default to "strict".
- **Tool error resilience**: Individual tool failures return error strings to the LLM rather than terminating the loop — the LLM can self-correct.
- **Skill lazy loading**: Skill frontmatter parsed at discovery; bodies loaded from disk on demand with LRU cache.
- **Atomic config writes**: temp file + rename pattern with backup file and secure permissions.
- **Constant-time security**: `crypto.timingSafeEqual` for API key hash comparison.
- **Extensible persistence**: Registry pattern allows third-party backends (Redis, Postgres, SQLite).
- **Middleware onion**: `compose()` chains cross-cutting concerns (auth, rate-limit, logging) outside the agent loop.
- **GLM provider reuse**: Anthropic-compatible API at `api.z.ai` with model aliases mapping Anthropic names to GLM IDs.
