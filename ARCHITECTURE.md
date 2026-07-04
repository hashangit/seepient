# Seepient Agent Architecture

Headless AI agent framework with CLI, SDK, and Server adapters. Multi-provider LLM support, skill plugin system, and Docker-native deployment.

## Layered Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Adapters (I/O & delivery)        Cognitive (BMI) ★     │
│  ┌──────────┐ ┌────────┐         ┌──────────────────┐   │
│  │   CLI    │ │  SDK   │         │ Conscience · AMG │   │
│  │ (TUI/    │ │ (Lib)  │         │ RAS · DMN · ...  │   │
│  │  REPL)   │ │        │         │ Hippo · Cortex · │   │
│  │  Server  │ └───┬────┘         │ Basal Ganglia    │   │
│  │ (WS+REST)│     │              └────────┬─────────┘   │
│  └────┬─────┘     │        assembles system prompt +    │
│       │           │        pre-call transform (RAS)     │
│       └───────────┴────────┐ ┌──────────────┘           │
│                           ▼ ▼                            │
│                         Core                            │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Agent Loop · Hooks · Tool Executor              │   │
│  │  Provider Resolver · Message Convert              │   │
│  │  Middleware · Skill Invoker · Session Store       │   │
│  │  Errors                                           │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  Infrastructure (the execution arms & legs)             │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────┐   │
│  │ Providers  │  │   Tools    │  │     Skills       │   │
│  │  (4 LLMs)  │  │ (22 tools) │  │ (Plugin system)  │   │
│  └────────────┘  └────────────┘  └──────────────────┘   │
│  ┌──────────────────────────────────────────────────┐   │
│  │                  Gateway                         │   │
│  │  (MCP client · REST proxy · OpenAPI · Semantic)  │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

All three adapters delegate to a single `runAgentLoop` implementation in the core layer.

> **★ The Cognitive (BMI) layer is planned — spec only.** No code lives under `src/core/bmi/` yet; the full design is in [`docs/superpowers/seepientagent-bmi/`](docs/superpowers/seepientagent-bmi/).
>
> The split is load-bearing: **cognition vs. execution**. The BMI owns the cognitive side — conscience (the immutable moral floor with veto power), amygdala (continuous safety-valence that can self-escalate), RAS (LLM-free attention/salience filter), DMN (offline self-model), persona, and memory (hippocampus working-memory, cortex long-term, basal-ganglia procedural skills). It does **not** execute anything itself: it assembles the system prompt and runs a pre-call RAS transform, then hands off.
>
> The **arms and legs** — the agent loop, tool executor, providers, the 22 tools, skills discovery, gateway — stay in Core and Infrastructure, and remain **BMI-agnostic**. `runAgentLoop` is unchanged by the BMI; it simply receives a system prompt the BMI assembled. This separation is what makes the components independently tunable, evolvable (conscience-gated), and verifiable. See `01-architecture.md` §5 ("modify-vs-new" table) for the contract that no execution system is duplicated by the BMI.

## Source Layout

```
src/
├── core/                    # Canonical execution engine
│   ├── agent-loop.ts        # Single agent loop (all adapters delegate here)
│   ├── types.ts             # Central type definitions
│   ├── hooks.ts             # Safe hook executor
│   ├── tool-executor.ts     # Tool registry, factory, resolution
│   ├── provider-resolver.ts # Re-export hub for provider-env + provider-config
│   ├── provider-env.ts      # Env var helpers, defaults, resolveFromEnv()
│   ├── provider-config.ts   # Types, singleton, mutation, getProvider()
│   ├── message-convert.ts   # SDK ↔ Provider message format conversion
│   ├── skill-invoker.ts     # Skill invocation orchestrator
│   ├── skill-catalog.ts     # Skill catalog builder for system prompt injection
│   ├── session-store.ts     # PersistenceBackend factory + registry, file & memory backends
│   ├── stream-manager.ts   # Shared streaming queue, async iterables, SSE
│   ├── errors.ts            # Error class hierarchy
│   ├── permission.ts        # Permission matrix (levels × risk categories)
│   ├── settings-schema.ts   # Static settings map, schema, env vars, categories
│   ├── settings-manager.ts  # SettingsManager (get/set/reset/list, persistence, masking)
│   ├── middleware.ts         # Pipeline types + compose()
│   ├── middleware/           # Built-in middleware
│   │   ├── logging.ts       # Request/response logging
│   │   ├── rate-limit.ts    # Token bucket rate limiting
│   │   ├── auth.ts          # Auth validation
│   │   └── semantic-tools.ts # Semantic tool injection middleware
│   └── index.ts             # Core barrel export
├── providers/               # LLM provider implementations
│   ├── types.ts             # LLMProvider interface
│   ├── factory.ts           # Provider creation (dynamic imports)
│   ├── openai.ts            # OpenAI + OpenAI-compatible
│   └── anthropic.ts         # Anthropic + GLM (via Anthropic SDK)
├── gateway/                  # MCP gateway, REST proxy, OpenAPI adapter
│   ├── types.ts             # Target, AuditRecord, GatewayConfig, GatewayHooks
│   ├── gateway.ts           # MCPGateway class (engine)
│   ├── semantic-scorer.ts   # Keyword-based tool relevance scoring
│   ├── tool-factory.ts      # 10 proxy tools + getInjectableTools()
│   ├── openapi-importer.ts  # OpenAPI spec fetch + parse + register
│   ├── settings-adapter.ts  # Dedicated storage for targets/credentials/routes
│   ├── index.ts             # Barrel: createGateway, types, factory exports
│   └── __tests__/           # Unit tests (scorer, tool-factory, settings-adapter)
├── skills/                  # Skill plugin system
│   ├── types.ts             # Skill, SkillFrontmatter interfaces
│   ├── registry.ts          # DefaultSkillRegistry with LRU body cache (lazy loading)
│   ├── loader.ts            # Multi-source skill discovery
│   ├── parser.ts            # YAML frontmatter parser (parseFrontmatter for discovery, parseSkillFile for full)
│   ├── args.ts              # Dynamic argument parsing + template substitution
│   ├── resolver.ts          # @path file reference resolution
│   └── index.ts             # Registry initialization
├── tools/                   # Built-in tools
│   ├── interface.ts         # ToolModule interface
│   ├── index.ts             # Tool registry + executeToolHandler
│   ├── core.ts              # Shell, file I/O, datetime
│   ├── browser.ts           # Playwright web content extraction
│   ├── screenshot.ts        # Full-page screenshots
│   ├── email.ts             # SMTP email
│   ├── search.ts            # Tavily web search
│   ├── notify.ts            # Feishu/DingTalk/WeCom notifications
│   ├── image.ts             # DALL-E image generation
│   ├── prompt-optimizer.ts  # Prompt enhancement via GPT
│   └── todos.ts             # manage_todos — persistent task list (rendered as the TUI GoalStatus panel)
├── adapters/
│   ├── cli/                 # Interactive terminal agent
│   │   ├── index.ts         # Commander setup; dispatches TUI (TTY) vs readline REPL
│   │   ├── repl.ts          # Readline fallback (non-interactive / piped / --docker)
│   │   ├── agent.ts         # Agent class (REPL state, skill catalog)
│   │   ├── bootstrap.ts     # Shared session setup (TUI + REPL)
│   │   ├── system-prompts.ts # Interactive vs non-interactive prompts (+ manage_todos nudge)
│   │   ├── setup.ts         # Interactive setup wizard
│   │   ├── config-loader.ts # Multi-source config loading
│   │   ├── docker-utils.ts  # Docker/non-interactive detection
│   │   ├── commands/        # Slash commands (/help, /clear, /exit, /compact, /sessions, /models, /settings, /gateway, …)
│   │   └── tui/             # Ink/React TUI (lazy-loaded, interactive only)
│   │       ├── index.tsx    # startTui — render + ink-reset lifecycle
│   │       ├── app.tsx      # TuiApp root (<Static> feed, live region, overlays, queue/steer)
│   │       ├── ink-reset.ts # Ink-internals reset (fullStaticOutput) → artifact-free resize
│   │       ├── feed-serializer.ts # Rebuild feed + todos from persisted messages (resume)
│   │       ├── session-export.ts  # JSON + Markdown transcript export
│   │       ├── types.ts     # FeedEntry union (…/info/logo)
│   │       ├── components/  # message-area, prompt-area (bordered), logo-banner,
│   │       │                # tool-call-block (+ inline diff-viewer), goal-status, footer, …
│   │       ├── hooks/       # use-agent (run state, todos, queue), use-feed, use-keybindings, …
│   │       ├── overlays/    # command-palette, model-selector, settings, session-selector, help
│   │       ├── diff/        # line-diff.ts (diff pkg, CRLF-normalized) + file-write-meta.ts guard
│   │       └── logo/        # gradient.ts — Tokyo Night 45° rainbow for the logo
│   ├── sdk/                 # Programmatic library (npm package)
│   │   ├── index.ts         # generateText, streamText, createAgent, settings
│   │   ├── settings.ts      # SDK settings facade (get/set/reset/list/onChange)
│   │   ├── agent.ts         # SdkAgent (session, streaming, provider switching)
│   │   ├── http.ts          # SSE streaming helpers
│   │   └── tools.ts         # Re-export layer
│   └── server/              # Standalone WebSocket + REST server
│       ├── index.ts         # HTTP server creation, core agent loop delegation
│       ├── websocket.ts     # WS re-export hub (setup + teardown)
│       ├── ws-types.ts      # WS type shims and protocol message interfaces
│       ├── ws-handlers.ts   # WS connection handlers and safe send│   ├── rest.ts          # REST endpoints (includes /v1/settings, /v1/providers, /v1/gateway routes)
│   ├── rest-gateway.ts  # Gateway REST route handlers (target CRUD, credentials, audit)
│   ├── server-core.ts   # Extracted serverGenerateText/serverStreamText
│   ├── settings-handlers.ts # Settings REST + WS handlers with async mutex
│       ├── auth.ts          # API key auth with scopes
│       ├── session-store.ts # Server sessions with TTL + concurrency, delegates to PersistenceBackend
│       └── standalone.ts    # Docker/production entry point
├── models-catalog.ts        # Provider model catalog
└── (no index.ts at root — entry points defined in package.json exports)
```

## Core Layer

### Agent Loop (`agent-loop.ts`)

The single execution engine. Runs an iterative loop:

1. Check abort signal
2. Resolve provider for this step (supports per-skill model switching via `ProviderFactory`)
3. Convert messages to provider format
4. Call `provider.chat()`
5. Process text response → emit step
6. Process tool calls → execute each → emit steps
7. If tool calls were executed, continue loop; otherwise stop

Returns `AgentLoopResult` with messages, steps, tool calls, usage, and finish reason (`stop` | `max_steps` | `error` | `aborted`).

### Middleware Pipeline (`middleware.ts`)

Composable `(ctx, next) => Promise<void>` chain that wraps `runAgentLoop`. When middleware is provided, the loop body runs as the final handler; errors from middleware (e.g., auth rejection) produce an error result with `finishReason: "error"`. When no middleware is provided, behavior is identical to before.

```typescript
interface PipelineContext {
  requestId: string;
  messages: Message[];
  provider: LLMProvider;
  model: string;
  toolDefs: ToolDefinition[];
  metadata: Record<string, unknown>;
  result?: { messages, steps, toolCalls, usage, finishReason };
  signal?: AbortSignal;
  startedAt: number;
}

type Middleware = (ctx: PipelineContext, next: () => Promise<void>) => Promise<void>;
```

Three built-in middleware in `src/core/middleware/`:

| Middleware | Purpose | Key options |
|------------|---------|-------------|
| `loggingMiddleware` | Logs request start + response with duration, model, steps, tokens | `logRequest`, `logResponse`, `logger` |
| `rateLimitMiddleware` | Token bucket per key, throws on limit exceeded | `maxRequests`, `windowMs`, `keyExtractor` |
| `authMiddleware` | Calls `validate(ctx)`, throws on failure | `validate`, `errorMessage` |
| `semanticToolInjectionMiddleware` | Scores user message against gateway-discovered tools, injects top-K into `ctx.toolDefs` | `gateway`, `topK` |

Usage via SDK:

```typescript
const result = await generateText("Hello", {
  middleware: [authMiddleware({ validate: (ctx) => !!ctx.metadata.apiKey })],
  metadata: { apiKey: "..." },
});
```

### Hooks (`hooks.ts`)

User-supplied callbacks wrapped in safe executors. Missing hooks are no-ops. Errors are caught and logged without disrupting the main flow.

| Hook | When |
|------|------|
| `beforeToolCall` | Before a tool executes |
| `afterToolCall` | After a tool completes |
| `onStep` | Each agent step (text or tool_call) |
| `onError` | On any error |
| `onFinish` | When the loop completes |

### Provider Resolver (`provider-resolver.ts`)

Re-export hub for `provider-env.ts` (env var helpers, defaults, `resolveFromEnv()`, `resolveGLMModel()`) and `provider-config.ts` (types, singleton, `getProvider()`, `addProvider()`, `saveConfig()`, etc.). Single source of truth for provider configuration. Resolution chain:

```
Explicit config (configureProviders())
  → Environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
    → Legacy env vars (SEEPIENT_API_KEY, OPENAI_BASE_URL) with deprecation warnings
      → Defaults (provider: openai, model: gpt-5.4)
```

Key exports: `configureProviders()`, `getProvider()`, `getProviderConfig()`, `resolveFromEnv()`, `addProvider()`, `removeProvider()`, `saveConfig()`.

### Tool Executor (`tool-executor.ts`)

Tools organized in four tiers:

| Tier | Tools |
|------|-------|
| **Core** | `execute_shell_command`, `read_file`, `write_file`, `get_current_datetime` |
| **Comm** | `send_email`, `web_search`, `send_notification` |
| **Advanced** | `read_website`, `take_screenshot`, `generate_image`, `optimize_prompt`, `use_skill` |
| **Presentation** | `manage_todos` — drives the TUI's persistent task panel; the agent replaces the full list each call and the TUI renders it via `GoalStatus` (excluded from the scrolling feed) |
| **Gateway** | `gateway_route`, `gateway_call_tool`, `gateway_call_rest`, `gateway_capabilities`, `gateway_read_resource`, `gateway_get_prompt`, `gateway_import_openapi`, `gateway_register_target`, `gateway_audit_log`, `gateway_usage_stats` |

Resolution accepts: group names (`"all"`, `"core"`), built-in tool names, or `UserToolDefinition` objects (via `tool()` factory). Deduplicates by name. Gateway proxy tools are registered in the static tool registry at startup (only when `gateway.enabled` is true). Additionally, semantic middleware can dynamically inject gateway-discovered tools into the agent's tool context per request (see [Gateway System](#gateway-system)).

**Tool results & metadata**: `executeTool` returns a `ToolResult` (`{ output, success, metadata? }`) rather than a bare string. Handlers may attach structured `metadata` (e.g. `write_file`'s `FileWriteMetadata` carrying old/new content) which the agent loop attaches to the `tool_call` `StepResult` for adapters to render — it never enters the `role: 'tool'` message sent to the provider (no LLM context pollution). SDK `streamText` step consumers also receive `step.metadata` (the server forwards only a narrow `{type, content, timestamp}` step subset, so it does not). `write_file` writes atomically (same-dir temp file + `fs.rename`, original untouched on failure) and captures the previous content; the TUI renders the change as an inline unified diff (`tui/diff/` + `components/diff-viewer.tsx`), computed with the `diff` package.

### Permission Pre-Filter (`permission.ts`)

Risk-based permission matrix controlling which tools auto-execute vs. require human approval. Three levels (`strict`, `moderate`, `permissive`) cross-referenced with four risk categories (`safe`, `edit`, `communications`, `destructive`).

```typescript
type PermissionLevel = "strict" | "moderate" | "permissive";
type ToolRiskCategory = "safe" | "edit" | "communications" | "destructive";
```

Key functions:

| Function | Purpose |
|----------|---------|
| `needsApproval(toolName, level, registry?)` | Returns `true` if the tool requires approval at the given level |
| `resolvePermissionLevel(flags)` | Resolves effective level from CLI flags, env var, and config |
| `getToolRiskCategory(toolName, registry?)` | Looks up a tool's risk category, defaults to `"destructive"` |

Applied in `runAgentLoop` as a pre-filter before tool execution. CLI uses `--strict`/`--moderate`/`--yolo`/`--headless` flags; SDK accepts `permissionLevel` option; Server enforces a `maxPermissionLevel` ceiling per connection.

### Settings System (`settings-schema.ts`, `settings-manager.ts`)

Schema-driven settings management with unified get/set/reset across CLI, SDK, and Server adapters.

**Schema** (`settings-schema.ts`): Static data mapping 35 dot-key settings to `AppConfig` paths, with validation metadata (type, secret, restart-required, enum values, min/max), env var overrides (22 mappings), and category grouping (6 categories: providers, permissions, tools, notifications, skills, gateway).

**Manager** (`settings-manager.ts`): `SettingsManager` class providing:

| Method | Description |
|--------|-------------|
| `get(dotKey)` | Read value with secret masking and origin resolution |
| `set(dotKey, rawValue)` | Validate → persist to config file → update in-memory → emit change event |
| `reset(dotKey)` | Remove from config file, revert to default (or env var) |
| `resetAll()` | Clear config file, rebuild from env vars |
| `list()` / `listByCategory()` | All settings with metadata |
| `onChange(callback)` | Subscribe to changes, returns unsubscribe function |

Key behaviors:
- **Secret masking**: Strings ≥8 chars show first 3 + last 4 chars; shorter show `******`
- **Origin resolution**: env var → project config → global config → default
- **Atomic persistence**: Write to temp file → rename, with backup
- **Deep merge**: Setting one provider key preserves sibling provider configs
- **Validation**: Type coercion (string → number/boolean), enum constraints, URL parsing, hostname regex
- **SettingsError**: Extends `SeepientError` with codes `SETTINGS_INVALID_KEY`, `SETTINGS_VALIDATION_FAILED`, `SETTINGS_WRITE_FAILED`

### Session Store (`session-store.ts`)

Composable persistence via `PersistenceBackend` interface: `save(id, SessionData)`, `load(id)`, `delete(id)`, `list()`. Factory function `createPersistenceBackend(config)` creates backends by type. `registerBackend(type, factory)` registers custom backends (Redis, SQLite, etc.). Built-in: `file` (JSON files in `~/.seepient/sessions/`) and `memory` (Map-based, for testing). Legacy `SessionStore`-based API (`createSessionStore`, `createMemoryStore`) preserved for backward compatibility.

### Error Hierarchy (`errors.ts`)

```
SeepientError (base: message, code, retryable)
├── ProviderError  (provider field)
├── ToolError      (tool field)
├── MaxStepsError  (steps field)
├── AbortedError
└── GatewayError   (target field, retryable is configurable)
```

Each error carries a machine-readable `code` and `retryable` flag for intelligent retry logic. `GatewayError` supports a configurable `retryable` parameter — configuration errors (disabled target, missing target) pass `retryable: false`, while transient errors (network failure, MCP server timeout) pass `retryable: true` (default).

## Provider Layer

All providers implement the `LLMProvider` interface:

```typescript
interface LLMProvider {
  chat(messages: ProviderMessage[], tools: ToolDefinition[], options?: ChatOptions): Promise<ProviderResponse>;
}
```

| Provider Type | Implementation | Notes |
|---------------|---------------|-------|
| `openai` | `OpenAIProvider` | Wraps `openai` SDK |
| `openai-compatible` | `OpenAIProvider` | Same class with custom `baseUrl` |
| `anthropic` | `AnthropicProvider` | Wraps `@anthropic-ai/sdk` |
| `glm` | `AnthropicProvider` | Same class with `api.z.ai/api/anthropic` base URL, model alias mapping |

Model aliases for GLM: `haiku` → `glm-4.5-air`, `sonnet` → `glm-4.7`, `opus` → `glm-5.1`.

Providers are created via dynamic import in the factory, keeping unused provider SDKs out of memory.

## Adapter Layer

### CLI Adapter

Two interactive modes, chosen by `resolveLaunchMode()` (the same predicate that selects the system prompt):

- **TUI (default in a TTY)** — a full Ink/React app in `src/adapters/cli/tui/`, lazy-loaded via dynamic `import('./tui/index.js')` so headless/SDK/Server builds never pull in React/Ink/figlet.
- **Readline REPL (fallback)** — for non-interactive / piped / `--docker` / `--no-interactive`; byte-identical to the pre-TUI CLI.

**Entry flow**: `index.ts` → parse args → `loadMergedConfig()` → `runSetup()` (if needed) → `bootstrapCliSession()` → `resolveLaunchMode()` → TUI (`startTui`) or REPL (`runChat`).

**TUI rendering model** — Ink `<Static>` + native terminal scrollback (the same model Command Code uses): completed feed entries are painted once into the terminal's own scrollback, so the mouse wheel scrolls natively (no mouse capture → no gibberish, no alternate-screen buffer). `ink-reset.ts` pokes Ink's internal `instances.js` to reset `fullStaticOutput`/`lastOutput` before a `<Static>` remount, keeping resize / expand / session-resume repaints artifact-free.

**TUI features**: bordered, always-visible prompt (input row in a rounded box; `/` + `@` autocomplete floats above it); a "Seepient Agent" figlet logo (Tokyo Night 45° rainbow gradient) as the first feed entry that scrolls away; a persistent task panel driven by `manage_todos`; overlays (command palette, model selector, settings editor, session selector, help); live token/cost footer; message queue + `/steer` (type during a run to queue, or `/steer <msg>` to interrupt + redirect).

**Session management**: list / resume / delete / rename / export (JSON) / transcript (Markdown) via the session-selector overlay. Resume rebuilds the feed **and** the todo panel from persisted messages (`feed-serializer.ts` routes `manage_todos` to the persistent panel, not the feed).

- **Config loading**: Global (`~/.seepient/setting.json`) + local (`.seepient/setting.json`) + env overrides
- **Interrupt handling**: ESC/Ctrl+C → `agent.abort()` (TUI owns raw stdin in TTY mode; the readline REPL uses `setupInterrupt()`)
- **Slash commands**: registry-based dispatch (`/help`, `/clear`, `/exit`, `/compact`, `/sessions`, `/settings`, `/models`, …)
- **Docker mode**: detects `.dockerenv`, switches to non-interactive + auto-approve shell

### SDK Adapter

Programmatic library published as `seepient` on npm.

Two entry points:
- `seepient` → `generateText()`, `streamText()`, `createAgent()`
- `seepient/server` → Server adapter (imports core directly, no SDK dependency)

`createAgent()` returns `SdkAgent` with: `chat()`, `chatStream()`, `switchProvider()`, `abort()`, `clear()`, `getHistory()`, `getUsage()`. Supports session persistence via `persist` option.

### Server Adapter

Standalone HTTP + WebSocket server. Delegates directly to `runAgentLoop` in core (no SDK dependency). REST endpoints for generate/stream/agent operations. WebSocket for real-time bidirectional communication with reconnection support.

- **Auth**: API key with scopes (`chat`, `admin`). Keys stored in `~/.seepient/api-keys.json`
- **Sessions**: TTL-based expiration, per-key concurrency limits
- **Deployment**: `seepient-server` binary, Docker image, or `docker-compose`

## Skills System

Plugin architecture for domain-specific extensions.

### Skill File Format

```yaml
---
name: docker-ops
description: Docker operations assistant
version: 1.0.0
tags: [docker, devops]
allowedTools: [execute_shell_command, read_file]
args: [environment, service]
model:
  provider: openai
  model: gpt-5.4
---

System prompt and instructions for the skill...
{{environment}} {{service}} template variables...
```

### Discovery

Skills are discovered from multiple sources with priority (last wins):
1. Built-in skills bundled with the package
2. User skills in `~/.seepient/skills/`
3. Project skills in `.seepient/skills/`
4. Custom paths via `SEEPIENT_SKILLS_PATH`

Discovery uses `parseFrontmatter()` which reads each skill file but discards the body text immediately, keeping only the YAML metadata and `filePath`. Bodies are loaded lazily from disk on first invocation via `registry.getBody()`, with an LRU cache (5 entries) in `DefaultSkillRegistry`.

### Invocation Flow

1. Parse skill name + args from user input
2. Look up skill in registry
3. Substitute template variables
4. Resolve `@path` file references (with path traversal protection)
5. If skill specifies a model, switch provider via `ProviderFactory`
6. Execute via `runAgentLoop`
7. Restore original provider

### Per-Skill Model Switching

Skills can specify a preferred provider and model in their frontmatter. The `createSkillProviderSwitcher()` factory in `src/core/skill-invoker.ts` handles temporary switching for any adapter:

```typescript
interface SkillProviderSwitcher {
  switchIfNeeded(skillResult: SkillInvocationResult): Promise<boolean>;
  restore(): void;
  readonly activeProvider: LLMProvider;
  readonly activeModel: string;
}
```

The CLI creates a switcher per skill invocation, applies it via `agent.switchProvider()`, and restores via `switcher.restore()` in a `finally` block. Other adapters (SDK, Server) can use the same factory.

## Cross-Cutting Systems

### Abort Mechanism

Three layers, all propagating to the same `AbortSignal`:

| Adapter | Trigger | Effect |
|---------|---------|--------|
| CLI | ESC key | Sets raw stdin listener → `controller.abort()` |
| SDK | `signal` option or `agent.abort()` | Direct `AbortSignal` |
| Server | WebSocket close / client disconnect | Signal propagation |

The signal reaches the provider's HTTP call, cancelling the in-flight request.

### Streaming

Async iterable pattern with queue-based backpressure. Used by SDK (`streamText`) and Server (SSE). SSE format follows the standard `data: ...\n\n` protocol with typed events (`text`, `tool_call`, `tool_result`, `error`, `done`).

### Configuration

Multi-layer merge with precedence (highest wins):

```
Environment variables
  → Local project config (.seepient/setting.json)
    → Global user config (~/.seepient/setting.json)
      → Defaults
```

Env var mapping per provider:
- OpenAI: `OPENAI_API_KEY`, `OPENAI_MODEL`
- Anthropic: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
- GLM: `GLM_API_KEY`, `GLM_MODEL`
- OpenAI-compatible: `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_MODEL`
- General: `LLM_PROVIDER`, `LLM_MODEL`

Legacy env vars (`SEEPIENT_API_KEY`, `OPENAI_BASE_URL`, `SEEPIENT_MODEL`) still work with deprecation warnings.

## Build & Deployment

### Build

TypeScript (`tsc`) targeting ES2022 with NodeNext module resolution. No bundler — direct compilation. Development via `tsx` for instant feedback.

### Package Exports

```json
{
  ".":       "dist/adapters/sdk/index.js",     // SDK library
  "./server": "dist/adapters/server/index.js"   // Server
}
```

Two binaries: `seepient` (CLI) and `seepient-server` (standalone server).

### Docker

Multi-stage build: build stage with full Node.js → production stage with compiled JS only. Includes system Chromium for Playwright tools, CJK fonts, non-root user, health check endpoint.

Volumes: `/data/sessions` (session persistence), `/mnt/skills` (custom skills).

Env var `SEEPIENT_SHELL_APPROVE=auto` enables non-interactive shell tool approval.

### CI/CD

GitHub Actions: tag-triggered NPM publish + GitHub release, plus docs deployment to GitHub Pages via VitePress.

### Documentation

VitePress site in `docs/` with sections: getting-started, guides, SDK reference, server, examples, superpowers (design specs).

## Gateway System

The Gateway is an Infrastructure-layer subsystem (alongside Providers, Tools, Skills) that acts as a universal API hub — MCP client, secure REST proxy, and OpenAPI auto-adapter.

### Architecture

```
src/gateway/
├── types.ts             # Target, AuditRecord, GatewayConfig, GatewayHooks
├── gateway.ts           # MCPGateway class — engine
├── semantic-scorer.ts   # Keyword-based tool relevance scoring
├── tool-factory.ts      # 10 proxy tools + getInjectableTools()
├── openapi-importer.ts  # OpenAPI spec fetch + parse + register
├── settings-adapter.ts  # Dedicated storage for targets/credentials/routes
├── index.ts             # Barrel: createGateway factory + exports
└── __tests__/           # Unit tests
```

### Two Complementary Patterns

1. **Semantic Injection (primary):** A middleware scores the user's message against all discovered gateway tools and injects the top-K most relevant directly into `ctx.toolDefs` before the agent loop runs. Zero context pollution — only relevant tools are visible to the LLM.

2. **Proxy Pattern (fallback):** When semantic injection finds no match, the LLM uses generic proxy tools (`gateway_route`, `gateway_call_tool`, etc.) to navigate targets, discover capabilities, and execute operations.

### Key Types

| Type | Purpose |
|------|---------|
| `Target` = `RestTarget` \| `McpTarget` | Union of MCP and REST target configurations |
| `GatewayConfig` | Settings: `enabled`, `semanticTopK`, `defaultRateLimitPerMin`, `maxAuditLogsInMemory` |
| `AuditRecord` | Audit trail entry (timestamp, agent, target, operation, status, duration) |
| `GatewayHooks` | Extension points: `onAudit`, `onSamplingRequest` |

### MCPGateway Engine

The `MCPGateway` class manages the full lifecycle:

- **Target management:** Register/unregister/toggle MCP and REST targets
- **MCP client connections:** Auto-connect on first use, cache by target name, lazy reconnection on failure
- **REST proxying:** Credential injection (bearer, header, basic, query), auth header construction
- **Routing:** Pattern-based + tag-based NL routing via `routeRequest()`
- **Semantic injection support:** `getInjectableTools()` returns `ToolModule[]` with `risk: "communications"` and `target__toolName` naming
- **Observability:** Ring-buffer audit logs, per-target usage summaries

### Credential Trust Guard

Targets registered by agents (via `gateway_register_target`) cannot resolve `credential:` prefixed environment variables — only admin-registered targets can. This prevents crafted targets from leaking stored credentials into untrusted MCP server environments.

### Settings Adapter

The `GatewaySettingsAdapter` provides dedicated storage for dynamic gateway data (targets, credentials, routes) in `~/.seepient/gateway/`. This bypasses the static `SettingsManager` which rejects unknown dot-keys. The 4 typed gateway settings (`gateway.enabled`, `gateway.semanticTopK`, `gateway.defaultRateLimitPerMin`, `gateway.maxAuditLogs`) go through `SettingsManager`; only the dynamic subtree uses the adapter.

### Gateway Adapter Wiring

All three adapters initialize the gateway at startup (when `gateway.enabled` is true in settings):

| Adapter | Gateway Init | Middleware | REST Routes |
|---------|-------------|-----------|-------------|
| **Server** | `createServer()` creates `GatewaySettingsAdapter` + `createGateway()` | `semanticToolInjectionMiddleware` passed to `serverGenerateText`/`serverStreamText` | `/v1/gateway/*` delegated to `rest-gateway.ts` |
| **CLI** | `runChat()` creates adapter + gateway, passes to `Agent` | `agent.setMiddleware([semanticToolInjectionMiddleware(...)])` | N/A (uses `/gateway` slash command) |
| **SDK** | `gateway.createGateway()` lazy-loaded on demand | Via `generateText`/`streamText` `middleware` option | N/A |

### Agent-Loop Bridge

The agent loop has two gateway-specific modifications (both inline, ~21 lines total):

1. **FinalHandler rebuilds options from `ctx`:** Captures middleware mutations (injected tools) so `executeLoop` sees the updated `toolDefs` and `injectedTools` map.

2. **Inline injected-tools lookup:** Before executing a tool, checks `config.injectedTools` for a dynamically injected module. If found, calls the injected handler directly (with `risk: "communications"`); otherwise falls through to `executeTool()`. Permission checks read risk from the injected module when available.

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single `runAgentLoop` implementation | All adapters share one execution engine — no behavioral divergence |
| Dynamic provider imports | Unused provider SDKs stay out of memory |
| Provider reuses (OpenAI↔compatible, Anthropic↔GLM) | Reduces maintenance surface — SDKs are API-compatible |
| Skills as files, not code | Portable, versionable, no build step for skill authors |
| `@path` reference resolution with allowlist | Convenience without compromising security |
| Hook errors are non-fatal | Observability hooks must never crash the agent loop |
| Token estimation (char-based) | Avoids extra API calls; sufficient for usage tracking |
| Gateway as Infrastructure layer | All adapters get gateway automatically; single wiring point |
| Dedicated `GatewaySettingsAdapter` | SettingsManager's static SETTINGS_MAP rejects dynamic keys; dedicated adapter avoids schema collision |
| Keyword-based semantic scoring | Zero dependencies, fast, deterministic |
| Semantic injection top-3 budget | Conservative on context window |
| Agent scope: can add targets, not remove | Self-service addition, human-gated removal |
| Credential trust guard (admin vs agent) | Prevents crafted targets from leaking stored credentials |
| Lazy MCP client reconnection | Simpler than health checks; sufficient for most scenarios |
