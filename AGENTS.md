# Guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

# Architecture

Full architectural reference: `ARCHITECTURE.md` in the project root.

## Layers

```
Adapters (CLI, SDK, Server) → Core (agent-loop) → Infrastructure (Providers, Tools, Skills)
```

All three adapters delegate to a single `runAgentLoop` in `src/core/agent-loop.ts`.

## Key Files

| Concern | File | Notes |
|---------|------|-------|
| Agent loop | `src/core/agent-loop.ts` | Single execution engine for all adapters |
| Core types | `src/core/types.ts` | Messages, tools, hooks, agents, sessions |
| Provider interface | `src/providers/types.ts` | `LLMProvider.chat()` — re-exports `ProviderType` from core |
| Provider factory | `src/providers/factory.ts` | Dynamic import per provider type |
| Provider resolver | `src/core/provider-resolver.ts` | Re-export hub for `provider-env.ts` + `provider-config.ts` |
| Tool executor | `src/core/tool-executor.ts` | Registry, `tool()` factory, `resolveTools()`, groups; `executeTool` → `ToolResult` (metadata passthrough) |
| Tool registry | `src/tools/index.ts` | Built-in tool modules + `executeToolHandler()` |
| Skill system | `src/skills/` | Registry, loader, parser, args, `@path` resolver |
| Skill catalog | `src/core/skill-catalog.ts` | `buildSkillCatalog()` for system prompt injection |
| Hooks | `src/core/hooks.ts` | Safe executor — errors never crash the loop |
| Middleware | `src/core/middleware.ts` | `PipelineContext`, `Middleware` type, `compose()` chain |
| Built-in middleware | `src/core/middleware/` | `logging`, `rate-limit`, `auth` |
| Errors | `src/core/errors.ts` | `SeepientError` hierarchy with `code` + `retryable` |
| Hashline | `src/core/hashline/` | Hash-anchored patch language: types, parser, patcher, snapshot store |
| Stream manager | `src/core/stream-manager.ts` | Shared streaming queue, async iterables, SSE for SDK and agent |
| Session store | `src/core/session-store.ts` | `PersistenceBackend` factory + registry, file & memory backends |
| Settings schema | `src/core/settings-schema.ts` | 31 dot-key settings, validation, env vars, 5 categories |
| Settings manager | `src/core/settings-manager.ts` | `SettingsManager` with get/set/reset/list, persistence, masking |
| SDK entry | `src/adapters/sdk/index.ts` | `generateText`, `streamText`, `createAgent`, `settings` |
| CLI entry | `src/adapters/cli/index.ts` | Commander setup; dispatches TUI (TTY) vs readline REPL |
| CLI REPL | `src/adapters/cli/repl.ts` | Readline fallback (`runChat()`), non-interactive / piped / `--docker` |
| CLI TUI | `src/adapters/cli/tui/` | Ink/React TUI (lazy, TTY only): `<Static>` + `ink-reset`; bordered input, figlet logo, todo panel, session manager, queue/`/steer`; widget host (`widget-host.ts`), ChatBlock lifecycle (`chat-block.ts`), widget renderers (`widgets/`) |
| TUI logo | `src/adapters/cli/tui/logo/gradient.ts` | Tokyo Night 45° rainbow for the logo |
| Todo tool | `src/tools/todos.ts` | `manage_todos` — persistent TUI task panel |
| Safe write + diff | `src/tools/core.ts` (`WriteFileTool`) + `tui/diff/` | Atomic `write_file` (temp + `fs.rename`); emits `FileWriteMetadata` → `StepResult.metadata` → TUI inline diff |
| Hash-anchored edit | `src/tools/edit-file.ts` | `edit_file` — targeted line patches via hash-anchored grammar; reuses `DiffViewer` |
| Generative widgets | `src/tools/widgets.ts` + `tui/widgets/` | `render_widget` tool + 9 L1 kind renderers (table, chart, product_card, form, …) |
| Feed rebuild | `src/adapters/cli/tui/feed-serializer.ts` | Resume: messages → feed + todos |
| System prompts | `src/adapters/cli/system-prompts.ts` | Interactive vs non-interactive (+ `manage_todos` nudge) |
| Server entry | `src/adapters/server/index.ts` | HTTP + WebSocket, delegates to core directly |

## Providers

4 providers behind `LLMProvider` interface:

| Type | Class | Shared with |
|------|-------|-------------|
| `openai` | `OpenAIProvider` | — |
| `openai-compatible` | `OpenAIProvider` | Same class, custom `baseUrl` |
| `anthropic` | `AnthropicProvider` | — |
| `glm` | `AnthropicProvider` | Same class, `api.z.ai/api/anthropic` base URL |

GLM model aliases: `haiku` → `glm-4.5-air`, `sonnet` → `glm-4.7`, `opus` → `glm-5.1`.

Provider resolution chain: explicit config → env vars → legacy env vars → defaults.

## Tools

15 built-in tools in 4 tiers:

- **Core**: `execute_shell_command`, `read_file`, `write_file`, `get_current_datetime`
- **Comm**: `send_email`, `web_search`, `send_notification`
- **Advanced**: `read_website`, `take_screenshot`, `generate_image`, `optimize_prompt`, `use_skill`
- **Presentation**: `manage_todos` — drives the TUI's persistent task panel (the agent replaces the full list each call; the TUI renders it via `GoalStatus`, excluded from the scrolling feed)

Custom tools: `tool({ description, parameters, execute })` → `ToolModule` registered via `registerTool()`.

## Skills

File-based plugin system. YAML frontmatter + body. Skills can specify allowed tools, preferred provider/model, and template args. Discovery from multiple sources with priority (last wins): built-in → `~/.seepient/skills/` → `.seepient/skills/` → `SEEPIENT_SKILLS_PATH`.

## Adapters

### CLI (`src/adapters/cli/`)

Two modes via `resolveLaunchMode()`: the **Ink/React TUI** (`tui/`, default in a TTY — bordered always-visible input, figlet "Seepient Agent" logo, persistent todo panel, session manager, message queue + `/steer`) and the **readline REPL** fallback (non-interactive / piped / `--docker`). Commander.js args → `loadMergedConfig()` → setup → `bootstrapCliSession()` → TUI or REPL. The TUI renders via `<Static>` + native scrollback (no mouse capture → no gibberish) with `ink-reset.ts` (Ink-internals poke) for artifact-free resize. Slash commands via registry (`/help`, `/clear`, `/sessions`, `/settings`, `/models`, …). ESC/Ctrl+C → `agent.abort()`.

### SDK (`src/adapters/sdk/`)

Programmatic library. Exports `generateText()`, `streamText()`, `createAgent()`. React hook via `seepient/react`. Session persistence via `persist` option.

### Server (`src/adapters/server/`)

HTTP + WebSocket standalone server. REST endpoints for generate/stream/agent. API key auth with scopes. Sessions with TTL and concurrency limits.

## Configuration

Multi-layer merge (highest wins): env vars → local `.seepient/setting.json` → global `~/.seepient/setting.json` → defaults.

Env vars per provider: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GLM_API_KEY`, `OPENAI_COMPAT_API_KEY` + `OPENAI_COMPAT_BASE_URL`. General: `LLM_PROVIDER`, `LLM_MODEL`. Legacy vars work with deprecation warnings.

## Conventions

- **No bundler** — plain `tsc` to ES2022 NodeNext. Dev via `tsx`.
- **Package exports** — `seepient` (SDK), `seepient/react`, `seepient/server`. Binaries: `seepient` (CLI), `seepient-server`.
- **Vitest test suite (partial)** — 322 tests across 33 files covering P0/P1 areas; CI gates publish on test pass
- **Errors carry metadata** — `code` (machine-readable) + `retryable` flag on all `SeepientError` subclasses.
- **Hook errors are non-fatal** — never crash the agent loop.
- **Dynamic provider imports** — unused provider SDKs stay out of memory.

## Known Gaps

- Tool registry exists in both `src/tools/index.ts` and `src/core/tool-executor.ts` — FIXED: single source in `src/core/tool-executor.ts`, `tools/index.ts` is pure module collection
- `ProviderType` defined in both `src/providers/types.ts` and `src/core/types.ts` — FIXED: single definition in `src/core/types.ts`, re-exported from `src/providers/types.ts`
- Streaming queue logic duplicated between SDK and Server — FIXED: `StreamManager` in `src/core/stream-manager.ts` is the single implementation
- Skill loading logic partially in CLI adapter instead of fully in `skill-invoker.ts` — FIXED: `createSkillProviderSwitcher()` in `src/core/skill-invoker.ts` replaces `switchToSkillModel()`/`restoreProvider()` from CLI `Agent` class; all adapters can now use skill provider switching
- Skill bodies eagerly parsed at startup — FIXED: `parseFrontmatter()` discards body on discovery, `getBody()` loads lazily from disk with LRU cache (5 entries)
- Server imports from SDK rather than directly from core — FIXED: server imports directly from core modules
- `any` types in tool definition paths — FIXED: `toolDefs: ToolDefinition[]`, `tools: ToolDefinition[]`
- No middleware pipeline for cross-cutting concerns — FIXED: `(ctx, next) => Promise<void>` middleware chain with `compose()`. Built-in logging, rate-limit, auth middleware in `src/core/middleware/`
- Skill catalog only in CLI system prompt — FIXED: `buildSkillCatalog()` in `src/core/skill-catalog.ts`, `skillCatalog` option on `AgentLoopOptions` for injection at agent-loop level
- No skill body size limits — FIXED: three-layer defense — load-time warning in `parser.ts`, injection-time truncation via `limitSkillBody()` in `skill-invoker.ts` and `tools/index.ts`, cumulative cap (2MB) in `resolver.ts`
- Large files with mixed responsibilities — FIXED: `websocket.ts` → `ws-types.ts` + `ws-handlers.ts` + re-export hub; `provider-resolver.ts` → `provider-env.ts` + `provider-config.ts` + re-export hub; `cli/index.ts` → `repl.ts` + `commands/skills.ts` + `commands/models.ts` + Commander setup
- Session persistence hardcoded in SDK agent — FIXED: `PersistenceBackend` interface with factory/registry in `src/core/session-store.ts`; custom backends via `registerBackend()`; server delegates raw storage to backend while keeping TTL/concurrency logic

<!-- dgc-policy-v11 -->
# Dual-Graph Context Policy

This project uses a local dual-graph MCP server for efficient context retrieval.

## MANDATORY: Always follow this order

1. **Call `graph_continue` first** — before any file exploration, grep, or code reading.

2. **If `graph_continue` returns `needs_project=true`**: call `graph_scan` with the
   current project directory (`pwd`). Do NOT ask the user.

3. **If `graph_continue` returns `skip=true`**: project has fewer than 5 files.
   Do NOT do broad or recursive exploration. Read only specific files if their names
   are mentioned, or ask the user what to work on.

4. **Read `recommended_files`** using `graph_read` — **one call per file**.
   - `graph_read` accepts a single `file` parameter (string). Call it separately for each
     recommended file. Do NOT pass an array or batch multiple files into one call.
   - `recommended_files` may contain `file::symbol` entries (e.g. `src/auth.ts::handleLogin`).
     Pass them verbatim to `graph_read(file: "src/auth.ts::handleLogin")` — it reads only
     that symbol's lines, not the full file.
   - Example: if `recommended_files` is `["src/auth.ts::handleLogin", "src/db.ts"]`,
     call `graph_read(file: "src/auth.ts::handleLogin")` and `graph_read(file: "src/db.ts")`
     as two separate calls (they can be parallel).

5. **Check `confidence` and obey the caps strictly:**
   - `confidence=high` -> Stop. Do NOT grep or explore further.
   - `confidence=medium` -> If recommended files are insufficient, call `fallback_rg`
     at most `max_supplementary_greps` time(s) with specific terms, then `graph_read`
     at most `max_supplementary_files` additional file(s). Then stop.
   - `confidence=low` -> Call `fallback_rg` at most `max_supplementary_greps` time(s),
     then `graph_read` at most `max_supplementary_files` file(s). Then stop.

## Token Usage

A `token-counter` MCP is available for tracking live token usage.

- To check how many tokens a large file or text will cost **before** reading it:
  `count_tokens({text: "<content>"})`
- To log actual usage after a task completes (if the user asks):
  `log_usage({input_tokens: <est>, output_tokens: <est>, description: "<task>"})`
- To show the user their running session cost:
  `get_session_stats()`

Live dashboard URL is printed at startup next to "Token usage".

## Rules

- Do NOT use `rg`, `grep`, or bash file exploration before calling `graph_continue`.
- Do NOT do broad/recursive exploration at any confidence level.
- `max_supplementary_greps` and `max_supplementary_files` are hard caps - never exceed them.
- Do NOT dump full chat history.
- Do NOT call `graph_retrieve` more than once per turn.
- Do NOT use npm to install dependencies. Use pnpm instead.
- After edits, call `graph_register_edit` with the changed files. Use `file::symbol` notation (e.g. `src/auth.ts::handleLogin`) when the edit targets a specific function, class, or hook.

## Context Store

Whenever you make a decision, identify a task, note a next step, fact, or blocker during a conversation, call `graph_add_memory`.

**To add an entry:**
```
graph_add_memory(type="decision|task|next|fact|blocker", content="one sentence max 15 words", tags=["topic"], files=["relevant/file.ts"])
```

**Do NOT write context-store.json directly** — always use `graph_add_memory`. It applies pruning and keeps the store healthy.

**Rules:**
- Only log things worth remembering across sessions (not every minor detail)
- `content` must be under 15 words
- `files` lists the files this decision/task relates to (can be empty)
- Log immediately when the item arises — not at session end

## Session End

When the user signals they are done (e.g. "bye", "done", "wrap up", "end session"), proactively update `CONTEXT.md` in the project root with:
- **Current Task**: one sentence on what was being worked on
- **Key Decisions**: bullet list, max 3 items
- **Next Steps**: bullet list, max 3 items

Keep `CONTEXT.md` under 20 lines total. Do NOT summarize the full conversation — only what's needed to resume next session.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
- **ACTIVE PLAN**: `specs/007-tui-parity-upgrade/plan.md` — TUI parity & generative
  widget upgrade (T0 streaming polish, T1 generative widgets, T3 hashline edits,
  T4 ChatBlock + component parity). Stays on Ink; 005 stays reverted.
<!-- SPECKIT END -->
