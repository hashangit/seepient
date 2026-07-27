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

# Documentation Storage

Documentation is split between the **Obsidian vault** (internal) and the **project repo** (consumer-facing). When unsure where a document belongs, default to the vault.

## Obsidian vault — internal documentation

All internal engineering and management documentation lives in the Obsidian vault under `Seepient/` (`~/Documents/Obsidian/Seepient/`), **not** in the project repo. This includes:

- Planning & architecture (e.g. `Architecture/`)
- Implementation specs & feature specs (e.g. `Implementation-Specs/007-tui-parity-upgrade/`)
- Research, data models, API/contract definitions
- Management documents (roadmaps, strategy, decisions, lessons learned)

**Access:** Read and write vault files directly via their filesystem paths (e.g. `Read` / `Write` / `Edit` on `~/Documents/Obsidian/Seepient/...`). The `obsidian` CLI only launches the GUI app and is not scriptable from agents — use direct filesystem access for all vault work.

## Vault structure

Current layout of the Obsidian vault (annotated):

```
~/Documents/Obsidian/Seepient/
├── README.md                         # Vault overview / index
├── Architecture/                     # Cross-cutting architectural references
├── Implementation-Specs/             # One folder per spec: NNN-kebab-name/
│   ├── 007-tui-parity-upgrade/       # TUI parity & generative widget upgrade
│   │   ├── spec.md                   # Problem statement, requirements, scope
│   │   ├── plan.md                   # Phased implementation plan
│   │   ├── tasks.md                  # Dependency-ordered tasks
│   │   └── ...                       # research.md, contracts/, etc. as needed
│   ├── 008-permission-system-redesign/  # OS sandbox + deny-layer + server policy
│   │   ├── spec.md                      # Bug sweep findings + scope decisions
│   │   ├── plan.md                      # P0-P6 plan (R9.1): policy, local/server enforcement, self-evolution, audit durability
│   │   ├── research.md                  # Cross-tool study + R8 end-to-end architecture review
│   │   ├── research-permissions-ux.md   # Deep-dive: Codex/OMP/Hermes implementation + interactive/non-interactive UX
│   │   ├── data-model.md                # Prepared actions, capabilities, brokers, execution boundaries, tool map, authority rules
│   │   ├── contracts/                   # sandbox-api.md, server-policy.md, tui-escalation.md, execution-brokers.md
│   │   ├── quickstart.md                # Per-phase validation scenarios
│   │   └── tasks.md                     # Dependency-ordered implementation tasks
│   └── 009-agents-md-alignment/      # AGENTS.md loader only (v3 — .agents/skills/ moves to separate spec)
│       ├── spec.md                   # Codex startup discovery, 4-layer trust hierarchy, drop-whole byte budget
│       ├── plan.md                   # P1 (loader+composer+resolver) → P2 (settings) → P3 (5 adapters) → P4 (trust+/context)
│       ├── research.md               # Codex semantics + compatibility matrix + R2 blocker disposition
│       ├── data-model.md             # AgentInstructionFile, FsAdapter, resolveSystemContext, resume re-resolve
│       ├── contracts/                # agents-md-loader.md, domain-composer.md, resolve-system-context.md, system-prompt-composition.md
│       ├── quickstart.md             # ~37 deterministic scenarios (no process.chdir, no chmod, no grep -v)
│       └── tasks.md                  # 40 dependency-ordered tasks, 14 regression gates
│   └── 011-tui-permission-scope-ux/       # Multi-tab TUI permission scope & duration UX
│       ├── spec.md                   # Problem statement, requirements, scope
│       ├── plan.md                   # Phased implementation plan
│       └── tasks.md                  # Dependency-ordered implementation tasks
├── 010-provider-management-redesign/ # Provider mgmt redesign: contracts + runtime + purpose/tier routing
│   ├── spec.md                       # Problem, 5 blockers + 4 gaps, scope decisions, success criteria
│   ├── plan.md                       # P0-P7 phased plan (contracts → Pi adapter → runtime → resolution → surfaces → reliability)
│   ├── tasks.md                      # Dependency-ordered task list per phase
│   ├── research.md                   # Resolves 5 blockers + 4 gaps (D1-D20)
│   ├── data-model.md                 # PurposeModelMap, ResolvedInvocation, dispatch inventory
│   ├── migration.md                  # v1→v2 config migration, lazy sessions, SDK deprecation
│   ├── quickstart.md                 # Per-phase validation scenarios + production budgets
│   └── contracts/                    # inference-adapter, canonical-messages, provider-config, credential-store, server-management-api, public-sdk
├── Provider-Management/              # LLM provider notes (incl. llm-provider-management-comparison.md — the architectural guideline for 010)
├── System-Prompts/                   # Prompt engineering references
├── Seepientagent-BMI/                # Body-model internal feature work
└── Todo/                             # Internal todos / scratch
```

**Conventions:**
- Top level holds cross-cutting references (`Architecture/`, `Provider-Management/`, `System-Prompts/`, etc.); per-feature work lives under `Implementation-Specs/`.
- Each spec gets a numbered folder (`NNN-kebab-name/`) with the standard files above. Not every file is required — create what the spec needs, in this style.
- New top-level areas (e.g. a `Decisions/` or `Roadmaps/` folder) should be added here when first created.

**Maintenance — keep this map in sync.** This tree is the agent's contract for what to expect in the vault. When you add, remove, rename, or restructure vault files/directories, update this tree in the same change. If unsure of the current state, verify with `find ~/Documents/Obsidian/Seepient -type f | sort`.

## Project repo — consumer-facing documentation

Consumer-facing documentation stays in the repo, alongside the code:

- Documentation websites (e.g. a VitePress site)
- User guides, examples, onboarding material
- `README.md`, `CHANGELOG.md`, and operational files

Code and operational files always stay in the repo; only internal/engineering/management prose moves to the vault.

# Architecture

Full architectural reference: `ARCHITECTURE.md` in the project root.

## Layers — six responsibilities, one dependency direction

```
UI → Transport → Domain → Capabilities → Vendors
           ↘________________↗
        Foundations (importable by any layer, imports from no one)
```

| Layer | Path | Job |
|-------|------|-----|
| **UI** | `src/ui/` | What the user sees: TUI, REPL, CLI args |
| **Transport** | `src/transport/` | Validate, auth, config resolution, delegate to Domain. No business logic |
| **Domain** | `src/domain/` | Product decisions: agent loop, permissions, hooks, middleware, streaming, sessions, settings, prompts |
| **Capabilities** | `src/capabilities/` | Stable internal APIs: LLM providers, tools, skills, gateway, tokenizer |
| **Vendors** | `src/vendors/` | Third-party SDK wrappers, quarantined |
| **Foundations** | `src/foundations/` | Shared types, errors, contracts, settings-schema, hashline, persistence |

**Hard rules:** no layer-skipping, no importing upward, no `utils/` grab-bag; no service-SDK import outside `src/vendors/`; sibling capabilities never import each other (shared vocabulary moves to `foundations/contracts/`); kebab-case file/folder names everywhere. UI frameworks (Ink, React, Commander, ws, figlet) are the sanctioned substrate of `ui/`.

**Composition roots** may wire across all layers — for wiring only, no logic. Sanctioned roots: CLI (`src/ui/cli/index.ts`, `src/transport/cli/bootstrap.ts`, `agent.ts`), TUI (`src/ui/tui/index.tsx`, `hooks/use-agent.ts`), REPL (`src/ui/repl/repl.ts`), Server (`src/transport/http/index.ts`, `server-core.ts`, `standalone.ts`), SDK (`src/transport/sdk/index.ts`, `agent.ts`). Tolerated type-only edges: transport commands importing `SkillRegistry`/`Target` types, `rest-gateway.ts` gateway types.

## Key Files

| Concern | File | Notes |
|---------|------|-------|
| Agent loop | `src/domain/agent-loop.ts` | Single execution engine for all adapters |
| Core types | `src/foundations/types.ts` | Messages, tools, hooks, agents, sessions |
| Error hierarchy | `src/foundations/errors.ts` | `SeepientError` with `code` + `retryable` |
| Contracts | `src/foundations/contracts/` | `LLMProvider`, `ToolModule`, `Middleware`, presentation contracts |
| Settings schema | `src/foundations/settings-schema.ts` | 31 dot-key settings, validation, env vars |
| Config + models | `src/foundations/config.ts` + `models-catalog.ts` | Merge layers + known-model list |
| Hashline | `src/foundations/hashline/` | Hash-anchored patch language: grammar, parser, patcher, snapshots |
| Tool executor | `src/domain/tool-executor.ts` | Registry, `tool()` factory, `resolveTools()`, groups |
| Permission system | `src/domain/permission.ts` + `grants.ts` | Policy decisions: what runs, when to ask, what to remember |
| Hooks | `src/domain/hooks.ts` | Safe executor — errors never crash the loop |
| Middleware pipeline | `src/domain/middleware/` | `compose()` chain: logging, rate-limit, auth, semantic-tools |
| Skill orchestration | `src/domain/skills/skill-invoker.ts` + `skill-catalog.ts` | Fill args, build prompt, switch provider |
| Streaming | `src/domain/streaming/` | Shared queue, async iterables, SSE |
| Sessions | `src/domain/sessions/session-store.ts` | `PersistenceBackend` factory + registry |
| Settings manager | `src/domain/settings/settings-manager.ts` | get/set/reset/list, persistence, masking |
| Provider resolution | `src/domain/providers/` | Choice, not calls — resolver, env, config |
| Context accounting | `src/domain/context/` | Context-breakdown, message-convert |
| LLM providers | `src/capabilities/llm/` | Anthropic, OpenAI, GLM, OpenAI-compatible behind `LLMProvider` |
| Tools | `src/capabilities/tools/` | 15 built-in tool modules: shell, files, web, email, widgets, todos… |
| Skills storage | `src/capabilities/skills/` | Registry, loader, parser, resolver, args |
| Gateway | `src/capabilities/gateway/` | MCP/OpenAPI client, scorer, tool factory |
| Tokenizer | `src/capabilities/tokenizer/` | `countTokens()` via `gpt-tokenizer` wrapper |
| System prompts | `src/domain/prompts/system-prompts.ts` | Interactive vs non-interactive |
| CLI UI entry | `src/ui/cli/index.ts` | Commander setup; dispatches TUI vs REPL |
| TUI | `src/ui/tui/` | Ink/React: components, widgets, diff, overlays, logo |
| REPL | `src/ui/repl/repl.ts` | Readline fallback, non-interactive / piped |
| CLI transport | `src/transport/cli/` | Bootstrap, setup, agent, config-loader, commands |
| HTTP transport | `src/transport/http/` | REST handlers, server core, standalone |
| WebSocket | `src/transport/ws/` | WS handlers, types |
| Auth | `src/transport/auth/` | API keys + scopes |
| SDK transport | `src/transport/sdk/` | `generateText`, `streamText`, `createAgent`, option resolution |

## Providers

4 providers behind the `LLMProvider` interface in `src/foundations/contracts/llm.ts`:

| Type | Class | Location |
|------|-------|----------|
| `openai` | `OpenAIProvider` | `src/capabilities/llm/openai.ts` |
| `openai-compatible` | `OpenAIProvider` | Same class, custom `baseUrl` |
| `anthropic` | `AnthropicProvider` | `src/capabilities/llm/anthropic.ts` |
| `glm` | `AnthropicProvider` | Same class, `api.z.ai/api/anthropic` base URL |

GLM model aliases: `haiku` → `glm-4.5-air`, `sonnet` → `glm-4.7`, `opus` → `glm-5.1`.

## Tools

15 built-in tools in 4 tiers (`src/capabilities/tools/`):

- **Core**: `execute_shell_command`, `read_file`, `write_file`, `get_current_datetime`
- **Comm**: `send_email`, `web_search`, `send_notification`
- **Advanced**: `read_website`, `take_screenshot`, `generate_image`, `optimize_prompt`, `use_skill`
- **Presentation**: `manage_todos` — drives the TUI's persistent task panel

Custom tools: `tool({ description, parameters, execute })` → `ToolModule` registered via `registerTool()`.

## Skills

File-based plugin system (`src/capabilities/skills/`). YAML frontmatter + body. Skills can specify allowed tools, preferred provider/model, and template args. Discovery from multiple sources with priority (last wins): built-in → `~/.seepient/skills/` → `.seepient/skills/` → `SEEPIENT_SKILLS_PATH`.

Domain orchestrates skill loading via `src/domain/skills/skill-invoker.ts` and `src/domain/skills/skill-catalog.ts`.

## Configuration

Multi-layer merge (highest wins): env vars → local `.seepient/setting.json` → global `~/.seepient/setting.json` → defaults. Managed by `src/domain/settings/settings-manager.ts`; schema in `src/foundations/settings-schema.ts`.

Env vars per provider: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GLM_API_KEY`, `OPENAI_COMPAT_API_KEY` + `OPENAI_COMPAT_BASE_URL`. General: `LLM_PROVIDER`, `LLM_MODEL`. Legacy vars work with deprecation warnings.

## Conventions

- **No bundler** — plain `tsc` to ES2022 NodeNext. Dev via `tsx`.
- **Package exports** — `seepient` (SDK), `seepient/server`. Binaries: `seepient` (CLI), `seepient-server`.
- **Vitest test suite** — 532 tests across 52 files; CI gates publish on test pass
- **Errors carry metadata** — `code` (machine-readable) + `retryable` flag on all `SeepientError` subclasses.
- **Hook errors are non-fatal** — never crash the agent loop.
- **Dynamic provider imports** — unused provider SDKs stay out of memory.
- **One-way dependency flow** — UI → Transport → Domain → Capabilities → Vendors. Foundations imported by all.

## Known Gaps

- Image and prompt-optimizer tools (`src/capabilities/tools/image.ts`, `prompt-optimizer.ts`) import the OpenAI SDK directly — should route through a `capabilities/media/` vendor-neutral interface
- Gateway registration (`src/capabilities/gateway/index.ts`) imports from Domain's `tool-executor` — should be wired at the composition root
- `use_skill` tool imports Skills internals directly — activation should be owned by Domain's skill invoker
- No automated layer-boundary lint enforcement yet — vendor quarantine and import-direction rules are aspirational
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
- **ACTIVE PLAN**: `~/Documents/Obsidian/Seepient/Implementation-Specs/008-permission-system-redesign/plan.md`
  — Permission system redesign R9.1: analyzer-only tools, one Domain policy and
  execution boundary, native exact commits, typed effect/secret/model-egress
  brokers, external Docker worker scheduler (localhost mTLS in R9.1, multi-host
  post-R9.1), protected policy/audit stores with persisted replay ledger and
  durable outbox, atomic authority consumption (action/run/session lifetimes),
  and a governed self-evolution activation boundary. Six-item reviewer
  correction: see decisions D45–D47. Prior
  plan: `specs/007-tui-parity-upgrade/` (TUI parity — shipped).
- **UPCOMING (planned, not yet in implementation)**: `~/Documents/Obsidian/Seepient/Implementation-Specs/009-agents-md-alignment/plan.md`
  — AGENTS.md standard alignment (v3, scope-narrowed after R2 review):
  Codex-compatible startup discovery (root → cwd walk, one file per directory,
  `AGENTS.override.md` replaces at level, 32 KiB drop-whole byte budget — a
  labeled Seepient divergence); one Domain `resolveSystemContext()` routes all
  five adapter paths (CLI, SDK×3, HTTP×2); resume re-runs the resolver against
  current cwd (no stale/cross-project instructions); four-layer trust hierarchy
  (runtime safety > explicit user prompt > project guidance > skill catalog,
  enforced by the permission system not by prompt position); two settings
  (`instructions.agentsMd.enabled`, `instructions.agentsMd.maxBytes`); HTTP
  accepts explicit `workspaceRoot`. **AGENTS.md only — `.agents/skills/`
  discovery is a separate future spec.** Based on `008-upgrade` at a clean SHA.
- **UPCOMING (planned, not yet in implementation)**: `~/Documents/Obsidian/Seepient/Implementation-Specs/010-provider-management-redesign/plan.md`
  — Provider management redesign: contract layer resolving the 5-blocker review
  (canonical inference contracts, normative config schema, aggregate media
  adapter ownership, Pi version pin, server security policy) + 4 planning gaps
  (purpose dispatch inventory, v1→v2 migration, retry defaults, production
  budgets). Implements the comparison doc's purpose × tier × thinking-level
  selection model behind a `PiAiInferenceAdapter` + instance-scoped
  `ProviderRuntime`. Phased P0-P7; architectural guideline lives in
  `Provider-Management/llm-provider-management-comparison.md`.
<!-- SPECKIT END -->
