# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Permission System Redesign R9.1** (#008): Production-ready single-path permission pipeline. Every tool call across CLI, TUI, REPL, SDK, and HTTP/WS routes through `PolicyEngine` → `ApprovalBroker` → `ExecutionBoundary` → `AuditRecorder`.
  - **Fail-Closed Defaults**: Process containment (`ProcessExecutor`) and exact-file commits (`CommitFilesExecutor`) default to fail-closed (`ISOLATION_UNAVAILABLE` and `EXACT_COMMIT_UNAVAILABLE`) when native isolation tools (`Seatbelt` / `Bubblewrap` / Rust commit helper) are absent. JS fallback write requires explicit opt-in (`allowFallback: true` or `SEEPIENT_ALLOW_JS_FS_FALLBACK=1`). Uncontained shell execution requires explicit operator opt-in (`unsafeUncontained: true`).
  - **Monotonic 4-Layer Intersection**: `effectiveCapabilities` strictly enforces maxAuthority = (deployment ∩ principal ∩ runtime) and effective = (maxAuthority ∩ active). User approvals are bound up to deployment and runtime limits without expanding outer ceilings.
  - **Real Process Containment**: Integrated `@anthropic-ai/sandbox-runtime` exact-pinned dependency for native macOS Seatbelt and Linux Bubblewrap process isolation. `probeSandbox` honestly advertises backend support.
  - **Durable Remote Approvals & Replay Protection**: `DurableApprovalStore`, `PersistedCapabilityLedger`, `PersistedReplayLedger`, and `TerminalEventOutbox` persist state with atomic writes (`tmp` + `fsync` + `rename`, `0o600`/`0o700` permissions, file locking with retry loops). WS composition root handles remote approvals durably across socket reconnects.
  - **Server Worker Backend**: `DockerSocketEngine` and `DockerWorkerScheduler` support single-host Docker worker execution with mTLS transport, Ed25519/HMAC signed dispatches, per-tenant workspace mounts, secret-free worker env, and durable replay protection.
  - **Model-Egress Gating**: `ModelEgressGate` evaluates model release for all tool outputs based on the action's declared data classes (`secret`, `active-policy`, `release-key`, `control-plane-credential`), keeping sensitive data out of model-visible history.

- **TUI parity & generative widget upgrade** (#007): Streaming polish (30fps throttle, `React.memo`, cursor hide), ChatBlock lifecycle primitive, `render_widget` tool with 9 kind renderers (table, keyvalue, chart, tree, panel, diff, form, product_card, status_grid), hash-anchored `edit_file` tool (SnapshotStore + parser + patcher with fail-closed stale anchor), enriched Markdown (GFM tables), T4 parity components (thinking indicator, TabBar, plan review overlay, truncated text, toast). Tools count: 13 → 15.
  - **Core**: `src/core/hashline/` — types, parser, patcher, snapshot-store; `WidgetError` + `HashlineError` in `errors.ts`.
  - **Tools**: `src/tools/widgets.ts` (`render_widget`), `src/tools/edit-file.ts` (`edit_file`).
  - **TUI**: `chat-block.ts`, `widget-host.ts`, `stream-flush.ts`, `widgets/` (9 renderers), `components/` (thinking-indicator, tab-bar, plan-review-overlay, truncated-text, toast), `hooks/` (use-cursor).

### Fixed

- **#007 scrutiny fixes**:
  - Widget host recreation on every render → stable `useMemo([], [])`.
  - Widget action keyboard wiring: `useInput` in `WidgetBlock` drives Tab/Enter through the action bar.
  - Hashline multi-op line drift: `sortOpsBottomToTop` ensures ops apply highest-line-first.
  - Hashline stale-anchor data loss: `tryThreeWayMerge` now fails closed (`HASHLINE_STALE_ANCHOR`) instead of silently destroying user content.
  - Widget resume: `feed-serializer.ts` rebuilds `render_widget` as finalized blocks.
  - SnapshotStore 1MB cap, duplicate action bars removed, dead `useBlockCleanup` deleted, `WidgetSpec` consolidated to one source.
  - System prompt: hashline grammar section added (op table, ordering rule, worked example).

- **Design skill** (`skills/design/SKILL.md`): Single bundled entry point for all design work. It is a router/dispatcher — it does not do design itself. On any design request it classifies the task, fetches the matching skill from the upstream OpenDesign catalogue (`https://raw.githubusercontent.com/nexu-io/open-design/main/skills/<slug>/SKILL.md` via `read_website`), maps upstream tool names to Seepient's tools, and follows that skill's procedure with Seepient's quality bar applied on top. Covers 145 verified upstream skills across 13 disciplines (process/brief/review, taste & aesthetic, brand, frontend/web, Figma/design systems, native platforms, slides/decks, image generation, social cards, video/motion, web animation/GSAP/Three.js, documents/editorial, audio). This mirrors how OpenDesign skills cross-reference Anthropic/Gemini design skills — one source of truth upstream, no drift. The new `design` skill brings the bundled-skill count to 13.

## [v0.3.0] - 2026-06-10

Major release adding the **Gateway subsystem** — a universal API hub that makes Seepient act as an MCP client, secure REST proxy, and OpenAPI auto-adapter. This release also includes two security fixes found during code scrutiny, a new middleware pipeline, and 10 new agent-facing gateway tools.

### Added

- **Gateway Engine** (`src/gateway/gateway.ts`): `MCPGateway` class managing target lifecycle, MCP client connections (stdio/SSE/HTTP), REST proxying with credential injection, pattern-based + semantic routing, and lazy reconnect on failure.
- **Semantic Tool Injection** (`src/core/middleware/semantic-tools.ts`): Middleware scores the user's last message against all discovered gateway tools using keyword relevance scoring and injects the top-K most relevant tools directly into the agent's tool context. Falls through to proxy pattern when no matches found.
- **Agent-Loop Bridge** (`src/core/agent-loop.ts`): FinalHandler rebuilds options from `ctx` to capture middleware mutations; inline injected-tools lookup dispatches to injected handlers or falls through to static tool registry. ~21 lines total.
- **10 Gateway Proxy Tools** (`src/gateway/tool-factory.ts`): `gateway_route`, `gateway_call_tool`, `gateway_call_rest`, `gateway_capabilities`, `gateway_read_resource`, `gateway_get_prompt`, `gateway_import_openapi`, `gateway_register_target`, `gateway_audit_log`, `gateway_usage_stats`.
- **OpenAPI Spec Importer** (`src/gateway/openapi-importer.ts`): Fetches OpenAPI specs (JSON/YAML), parses paths/operations, and auto-registers as a REST target. Supports tag filtering and base URL override.
- **Gateway Settings Adapter** (`src/gateway/settings-adapter.ts`): Dedicated file-based storage (`~/.seepient/gateway/`) for targets, credentials, routes, and admin-target registry. Atomic writes with temp-file+rename pattern. Credential files written with `mode: 0o600`.
- **Gateway Settings Schema** (`src/core/settings-schema.ts`): 4 typed settings (`gateway.enabled`, `gateway.semanticTopK`, `gateway.defaultRateLimitPerMin`, `gateway.maxAuditLogs`) in a new "Gateway" category. Env vars: `SEEPIENT_GATEWAY_ENABLED`, `SEEPIENT_GATEWAY_RATE_LIMIT`.
- **Semantic Scorer** (`src/gateway/semantic-scorer.ts`): Zero-dependency keyword-based relevance scoring with 80+ stop words for filtering noise.
- **Gateway REST Routes** (`src/adapters/server/rest-gateway.ts`): 11 REST endpoints under `/v1/gateway/*` for target CRUD, credentials, routes, OpenAPI import, audit logs, and usage stats. Proper auth scoping (`agent:read` for reads, `admin` for mutations).
- **Server-Core Extraction** (`src/adapters/server/server-core.ts`): Extracted `serverGenerateText`/`serverStreamText` from `server/index.ts`. Both accept optional `middleware` parameter for gateway semantic injection.
- **CLI `/gateway` Command** (`src/adapters/cli/commands/gateway.ts`): Full management: list, add, remove, toggle, routes, credentials, audit, usage. Wired into REPL with `gw` alias.
- **SDK Gateway Namespace** (`src/adapters/sdk/index.ts`): Lazy-loaded `gateway.createGateway()` for programmatic gateway creation.
- **GatewayError** (`src/core/errors.ts`): New error class with configurable `retryable` flag and `target` metadata. Configuration errors are non-retryable; transient errors are retryable.
- **Credential Trust Guard** (`src/gateway/gateway.ts`): Agent-registered targets cannot resolve `credential:` env vars or `auth.credentialRef` — only admin-registered targets can. Prevents crafted targets from exfiltrating stored credentials.
- **Injectable Tools Cache** (`src/gateway/gateway.ts`): `getInjectableTools()` caches its result and invalidates on target mutations for performance.
- 14 new unit tests across gateway, settings-adapter, semantic-scorer, tool-factory, and middleware modules.

### Fixed

- **B3 Security: Trust guard gap in credential resolution** (`src/gateway/gateway.ts`): `callRest()` and `connectMcpClient()` SSE/HTTP auth headers resolved `credentialRef` for ALL targets regardless of admin status. A non-admin target could register with `auth.credentialRef` pointing to a stored credential and exfiltrate it via REST calls. Now gated behind `adminTargets.has(targetName)` check.
- **B3 Security: OpenAPI import bypassed trust guard** (`src/gateway/openapi-importer.ts`, `src/gateway/tool-factory.ts`): `importOpenApiSpec()` registered all imported targets with `isAdmin=true`, but the agent-facing `gateway_import_openapi` tool called it directly — letting the agent create admin-registered targets with full credential access. Added `isAdmin` parameter; agent tool now passes `isAdmin: false`.
- **JSON parsing returned 500 instead of 400** (`src/adapters/server/rest-gateway.ts`): All `JSON.parse()` calls in gateway REST handlers were unwrapped — malformed request bodies threw exceptions caught by the outer handler as 500 INTERNAL_ERROR. Extracted `parseJsonBody<T>()` helper that returns 400 BAD_REQUEST on parse failure.
- **TypeScript compilation errors in test files** (`src/core/__tests__/semantic-tools.test.ts`, `src/gateway/__tests__/gateway.test.ts`): Message objects missing required `id`/`timestamp` fields (TS2739); `getAdminTargets` mock returned `string[]` instead of `Set<string>` (TS2322); credential injection tests registered targets without `isAdmin=true`, now correctly aligned with trust guard.

### Changed

- **Tool count**: 12 → 22 built-in tools (10 gateway proxy tools added).
- **Settings count**: 31 → 35 typed settings (4 gateway settings added).
- **Settings categories**: 5 → 6 ("Gateway" category added).
- **Dependencies**: Added `@modelcontextprotocol/sdk` (^1.29.0) and `js-yaml` (^4.2.0).
- Agent loop `finalHandler` now rebuilds options from middleware context (`ctx`) before calling `executeLoop`, capturing injected tool definitions.
- Server `createServer()` initializes gateway at startup when `gateway.enabled` is true, wiring semantic middleware into both REST and WebSocket paths.
- CLI `runChat()` initializes gateway at startup, wires middleware into Agent, and passes gateway instance to command registry.
- `MCPGateway.registerTarget()` validates `kind` field (must be `mcp` or `rest`).
- `MCPGateway.toggleTarget()` now persists the toggled state via settings adapter.
- `MCPGateway.unregisterTarget()` cleans up routes, MCP clients, admin tracking, and injectable tools cache.

### Security

- **Critical**: B3 credential trust guard extended to REST proxy auth headers — agent-registered targets can no longer resolve `credentialRef` to exfiltrate stored credentials.
- **Critical**: OpenAPI import from agent tools now creates non-admin targets; only REST API (admin scope) and CLI create admin targets with full credential access.
- **Medium**: All gateway REST endpoints return 400 (not 500) for malformed JSON request bodies.
- **Low**: Credential files written with `mode: 0o600` on Unix systems.

## [v0.2.2] - 2026-06-10

This release fixes five bugs found during a holistic system audit — two that could silently lose data under real workloads, one that broke SSE streaming order, one that left provider state corrupted after skill execution, and one that made `agent.abort()` a no-op during streaming. Session files are now written atomically, and a brand discriminator on `PersistenceBackend` stops metadata from being stripped when custom backends are passed to `createAgent()`.

### Fixed

- **SSE events arrived out of order** (`stream-manager.ts`): `toSSEStream()` drained the text queue completely before touching the step queue, so consumers saw all text deltas first, then all tool events — even when tools actually ran between text chunks. Added a unified `eventQueue` that preserves the real interleaved order. Text and step streams still work independently for non-SSE consumers.
- **`agent.abort()` did nothing during `chatStream()`** (`sdk/agent.ts`): `chatStream()` created its own local `AbortController`, but `agent.abort()` still called `.abort()` on a stale closure variable. Now tracks a single `activeAbortController` that both `chat()` and `chatStream()` assign before starting the loop.
- **`PersistenceBackend` instances lost metadata on save** (`sdk/agent.ts`, `types.ts`, `session-store.ts`): `wrapAsPersistenceBackend()` couldn't tell `SessionStore` from `PersistenceBackend` — both have a `save` method, so it always wrapped, calling `.save(id, data.messages)` and throwing away `createdAt`, `provider`, `model`, and custom `metadata`. Added a `__persistenceBackend` brand field to the interface and both built-in backends; the wrapper now passes through branded instances untouched. **Breaking**: third-party `PersistenceBackend` implementations must add `readonly __persistenceBackend = true as const`.
- **Skill provider switching leaked state after loop exit** (`agent-loop.ts`): `providerFactory.restore()` was only called inside the tool-calls block. On text-only completion, errors, or aborts, the factory stayed in a switched state — the next agent run would start with the wrong provider. Wrapped the entire loop body in `try/finally` so `restore()` runs on every exit path.
- **Concurrent `chat()`/`chatStream()` calls corrupted the message history** (`sdk/agent.ts`): `chatStream()` runs the agent loop in a background IIFE and returns immediately. Nothing prevented a second call from starting while the first was still mutating the shared `messages` array — no lock, no guard. Added a promise-based `acquire()`/`release()` lock that serializes all chat operations. A second call blocks until the first completes.
- **Session files were not written atomically** (`session-store.ts`): `FilePersistenceBackend.save()` used a bare `fs.writeFile()` — a crash mid-write left a corrupt JSON file. Now writes to a temp file first, then renames to the target path, matching the atomic pattern already used by `SettingsManager`.
- **Middleware errors left no audit trail** (`agent-loop.ts`): When outer middleware (auth, rate-limit) threw, the error was caught and returned as a structured result, but nothing was logged. Added a `console.error` in the middleware catch block so rejected requests show up in server logs.

### Changed

- Redesigned `/settings` interactive mode into a 3-level drill-down wizard with bordered ASCII headers and mini-forms.
- Reorganized settings categories from 6 to 5: Providers & Models, Permissions & Safety, Tools & Integrations, Notifications, Skills.
- `/settings` with no arguments now launches the wizard (was a plain list).
- Removed `/settings edit` and `/settings wizard` subcommands.
- All 12 built-in tools now carry a `risk` field (`safe`, `edit`, `communications`, or `destructive`).
- `--headless` flag replaces the binary `SEEPIENT_SHELL_APPROVE` approval mechanism.
- Unknown and custom tools default to `destructive` risk category, requiring approval in all modes except `permissive`.
- `ToolModule` interface now includes optional `risk` field.
- `permissionMode` option removed from `AgentCreateOptions` (replaced by `permissionLevel`).

### Added

- `/setup` slash command to access the setup wizard directly.
- Bordered mini-form with type-appropriate prompts (password masking, enum lists, boolean confirms).
- Env var override warnings in the setting editor.
- Number field validation with min/max constraints.
- **Permission Levels System**: 3-tier permission matrix (strict/moderate/permissive) with 4 tool risk categories (safe/edit/communications/destructive) controlling which tools auto-execute vs. require human approval.
- CLI flags: `--headless`, `--strict`, `--moderate`, `--yolo` for controlling tool approval behavior.
- SDK: `permissionLevel` option on `GenerateTextOptions`, `StreamTextOptions`, and `AgentCreateOptions`.
- Server: per-message permission level with `maxPermissionLevel` ceiling per connection.
- `SEEPIENT_PERMISSION` environment variable and settings file support for default permission level.
- `src/core/permission.ts` — Permission matrix with 3 pure functions (`needsApproval`, `resolvePermissionLevel`, `getToolRiskCategory`).
- 12 built-in tools categorized by risk; custom tools default to "destructive" (deny-by-default).
- 25 new tests (22 in `permission.test.ts`, 3 in `tool-executor.test.ts`).
- **Settings System**: Schema-driven settings management with CLI, SDK, and Server adapters.
- `src/core/settings-schema.ts` — 37 settings mapped to AppConfig paths with validation metadata, env var overrides, and category grouping.
- `src/core/settings-manager.ts` — SettingsManager with get/set/reset/list/onChange, secret masking, origin resolution, atomic file persistence, and deep merge for provider configs.
- CLI `/settings` command with subcommands: `list`, `get`, `set`, `reset`, `edit`, `wizard`, `export`, `help`. Aliases: `/config`, `/setting`.
- SDK `settings` facade exporting get/set/apply/list/listByCategory/onChange/reset/resetAll.
- Server REST endpoints: `GET/PATCH /v1/settings`, `GET /v1/settings/schema`, `POST/PATCH/DELETE /v1/providers`.
- Server WebSocket message types for settings get/update/change broadcast.
- 58 new tests (30 unit + 28 integration) covering schema, manager, validation, persistence, events, and secret masking.

### Security

- **Critical**: WebSocket tool approvals are now bound to the originating connection, preventing cross-connection approval bypass.
- **High**: `autoConfirm` state is captured immutably at agent construction time, preventing runtime mutation attacks.
- **High**: Tool denial messages use generic text ("Tool execution denied.") to prevent information leakage.
- **Medium**: Unknown permission level values are validated in server ceiling comparison, preventing ceiling bypass via invalid levels.
- **Medium**: Custom tool registry is included in risk lookups alongside built-in tools.
- **Low**: Conflicting `--headless` and permission level flags produce a warning.
- **Low**: Legacy `SEEPIENT_SHELL_APPROVE` env var is ignored when new permission flags are active.

## [v0.2.1] - 2026-04-09

### Fixed
- Corrected Homebrew formula SHA256 checksum to match npm-published tarball.

## [v0.2.0] - 2026-04-09

### Added

- **Skills System**: Loadable skill packs with `@path` references, workspace setup, and built-in skills (docker-ops, k8s-deploy, log-analyzer).
- **SDK (Programmatic API)**: Full TypeScript SDK with `createAgent`, `streamText`, `generateText`, structured output, React hooks, and session persistence.
- **Server Adapter**: Standalone HTTP/WebSocket server with REST API, session management, and authentication (API key + bearer token).
- **Docker Support**: Production-ready Dockerfile, `.dockerignore`, `docker-compose.yml`, `--docker` CLI flag, and non-interactive environment detection.
- **Shell Approval Modes**: Dual-mode shell command approval — interactive inquirer prompt and non-interactive `SEEPIENT_SHELL_APPROVE` env var with `auto`/`deny` modes.
- **Standalone Server Binary**: `seepient-server` with `--generate-api-key` flag, env var configuration, and graceful shutdown.
- Environment variable overrides for provider API keys.
- VitePress documentation site.

### Changed

- **Modular Multi-Adapter Architecture**: Restructured from monolithic `index.ts` into `core/`, `adapters/{cli,sdk,server}/`, `providers/`, `skills/`, `tools/`.
- **Unified Core**: Shared agent loop, provider resolver, tool executor, error hierarchy, and hooks system across all adapters.
- Extracted error hierarchy into `src/core/errors.ts`.
- Extracted tool executor into `src/core/tool-executor.ts`.
- Split CLI adapter into focused modules (`agent.ts`, `config-loader.ts`, `setup.ts`, `index.ts`).
- Standardized `OPENAI_COMPAT_*` environment variables.
- Updated default models catalog.
- Session store with filesystem backend for persistent session management.

### Fixed

- Corrected parentheses in provider resolution logic.

### Removed

- Monolithic `src/index.ts` entry point (replaced by modular architecture).
