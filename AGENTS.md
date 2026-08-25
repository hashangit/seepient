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

## 5. In-Place Upgrades & No Legacy Baggage

**Upgrade directly. Do not preserve obsolete paths.**

- When modifying or iterating on a feature, rewrite and replace existing functions, components, and contracts directly in place rather than appending alternate implementations, `V2` suffixes, parallel helpers, or wrapper shims.
- Do not keep backward compatibility shims, fallback branches, or deprecated functions unless explicitly instructed.
- When an updated approach replaces an older mechanism, delete the legacy code paths, obsolete flags, and unused options immediately in the same change.

## 6. Zero Tolerance for Dead Code & Bloat

**Leave no orphans or obsolete baggage.**

- Always remove unused imports, dead variables, obsolete handlers, orphaned types, and unreachable conditionals before completing an edit.
- Clean up tests, fixtures, or mock data that tested obsolete code paths.
- Apply dead-code detection discipline (e.g. `knip`, `ts-prune`) to ensure no unused exports, orphan files, or dangling dependencies remain.

## 7. The Greenfield Rewrite Pattern

**Prefer complete, clean replacement over additive patchworks.**

- When significantly updating or refactoring a feature, avoid stacking incremental condition checks, flags, or wrapper shims on top of legacy code (which creates brittle, additive patchworks).
- Treat significant iterations as a clean-slate replacement of the component/module: write the new streamlined implementation, replace the old code in place, and wire the callers directly.

## 8. Pre-1.0 / Beta Lifecycle & Breaking Changes

**Rapid improvement phase — no legacy shims before v1.0.0.**

- **Pre-1.0 (Beta state)**: Seepient currently has no production consumers requiring backward compatibility guarantees. Do not add compatibility shims, fallback adapters, or deprecation wrappers during the pre-1.0 phase. Upgrade callers and consumers immediately to the new pattern.
- **Documenting Breaking Changes**: When introducing breaking changes that require consumers of Seepient to update their code or configuration, document the changes with explicit transition/migration instructions. Consumers should always adapt to the new version rather than relying on legacy fallbacks.
- **Post-1.0 Stability**: Once Seepient reaches its first stable release (`v1.0.0+`), transition to a standard deprecation policy (e.g. deprecation warning with backward compatibility retained for one minor version release before removal). Until then, bias entirely toward clean, unburdened, in-place upgrades.

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
│   ├── 011-tui-permission-scope-ux/       # Multi-tab TUI permission scope & duration UX
│   │   ├── spec.md                   # Problem statement, requirements, scope
│   │   ├── plan.md                   # Phased implementation plan
│   │   ├── tasks.md                  # Dependency-ordered implementation tasks
│   │   ├── research.md               # Contract and authority-boundary decisions
│   │   ├── data-model.md             # Request, option, decision, and lifecycle model
│   │   ├── contracts/                # Policy-option and TUI prompt contracts
│   │   ├── quickstart.md             # Automated and manual validation scenarios
│   │   └── checklists/requirements.md # Specification quality checklist
│   └── 012-unified-media-generation-engine/  # Unified media engine: Vercel AI SDK + Fal + local pillars
│       ├── spec.md                   # Four pillars, scope decisions M1–M11, success criteria; standalone-package amendment
│       ├── package-charter.md        # Charter for MIT package `seepient-unified-media-generation-provider` (own repo): API surface, license, Seepient boundary
│       ├── plan.md                   # P0–P7 phased plan (schemas → vendors → runtime → catalog → surfaces → legacy collapse) + package/integration artifact split
│       ├── research.md               # SDK surface research (Vercel AI SDK, fal Platform API v1, LocalAI) + D1–D8
│       ├── data-model.md             # Media schemas, ports, backend registry, capability classifier, dispatch inventory
│       ├── quickstart.md             # Per-phase validation scenarios + production budgets (split package/Seepient)
│       ├── tasks.md                  # T001–T055 dependency-ordered tasks (US1–US6, test-first, two-repo split)
│       └── contracts/                # media-inference, media-schemas, media-catalog, media-surfaces
│   ├── 013-provider-management-tui/  # Shared provider mgmt TUI: dock + wizard + OAuth + CLI/server/SDK parity (013)
│   │   ├── spec.md                   # Product spec: 8 prioritized stories, FR-001–FR-040, success criteria
│   │   ├── plan.md                   # M1–M7 build order; verified current-state + surface audits; rules R1–R15
│   │   ├── tasks.md                  # T001–T064 dependency-ordered work orders (test-first, per-phase gates)
│   │   ├── research.md               # oh-my-pi provider-TUI study (/providers, /model, ModelBrowser) + decision ledger D1–D15
│   │   ├── data-model.md             # Persisted shapes (ProviderEntry, CredentialRef, PurposeModelMap) + UI view models
│   │   ├── quickstart.md             # QS-M1–QS-M5 manual validation scenarios + production budgets
│   │   ├── manual-validation-results.md # Manual scenario results (QS-M1–M5, QS-O, QS-P)
│   │   ├── checklists/requirements.md # Specification quality checklist (validated)
│   │   └── contracts/                # provider-manager-api, model-manager-dock, setup-wizard
│   └── 014-provider-catalog-automation/ # Automated provider catalog freshness & upstream sync (014)
│       ├── spec.md                   # Problem statement, requirements, scope
│       ├── plan.md                   # Phased implementation plan
│       ├── tasks.md                  # Dependency-ordered tasks T001–T011 (test-first, phase gates)
│       ├── research.md               # Upstream sync, tier resolver scoring, zero-day passthrough, D6 auto-publish boundary
│       ├── data-model.md             # UpstreamModel metadata, PersistedDiscoveryRecord (future contract), TierScoringCriteria
│       ├── contracts/                # ci-cd-automation.md, resolver-policy.md, passthrough-and-discovery.md
│       └── quickstart.md             # Automated validation scenarios (QS-P1 to QS-P4)
│   └── 015-god-file-decomposition/   # God-file decomposition (015): evidence-gated splits
│       ├── spec.md                   # FR-001–FR-008, non-goals (leave-alone list), success criteria
│       ├── plan.md                   # P1 post-014 window (ws/http/TUI) + P2 post-008 (lifecycle helpers)
│       ├── tasks.md                  # T001–T025 dependency-ordered, US1–US4 stories, per-story QS gates
│       ├── research.md               # Churn/fan-in measurements + decision ledger D1–D11
│       ├── data-model.md             # Symbol → target relocation maps, module-singleton inventory
│       ├── contracts/                # safety-gates.md (five test gates + module-surface contract)
│       └── quickstart.md             # QS-1–QS-4 + QS-P per-phase validation
├── 010-provider-management-redesign/ # Provider mgmt redesign: contracts + runtime + purpose/tier routing
│   ├── spec.md                       # Problem, 5 blockers + 4 gaps, scope decisions, success criteria
│   ├── plan.md                       # P0-P7 phased plan (contracts → Pi adapter → runtime → resolution → surfaces → reliability)
│   ├── tasks.md                      # Dependency-ordered task list per phase
│   ├── research.md                   # Resolves 5 blockers + 4 gaps (D1-D20)
│   ├── data-model.md                 # PurposeModelMap, ResolvedInvocation, dispatch inventory
│   ├── migration.md                  # v1→v2 config migration, lazy sessions, SDK deprecation
│   ├── quickstart.md                 # Per-phase validation scenarios + production budgets
│   ├── remediation-plan.md           # Post-P7 review fix plan: WS0-WS10 (secret-leak blocker, catalog-native redesign, Pi pin bump, OMP enrichment)
│   ├── cleanup-plan.md               # v1 demolition: P0-P9 phased removal of legacy provider path (bridges, dual paths, v1 config)
│   └── contracts/                    # inference-adapter, canonical-messages, provider-config, credential-store, server-management-api, public-sdk
├── Website Planning/                 # Public website strategy and delivery planning
│   ├── implementation_planv0.1.md    # Original kinetic-design exploration
│   ├── implementation_planv0.2.md    # Benchmark and product-strategy iteration
│   ├── implementation_planv0.3.md    # Universal-scenarios iteration
│   └── plan.md                       # Consolidated, evidence-led website master plan
├── Provider-Management/              # LLM provider notes (incl. llm-provider-management-comparison.md — the architectural guideline for 010)
├── System-Prompts/                   # Prompt engineering references
├── Seepientagent-BMI/                # Body-model internal feature work
└── Todo/                             # Internal todos / scratch
    ├── deferred-tui-items.md         # TUI backlog
    └── homebrew-json-gem-fix.md      # Runbook: Homebrew 6.0 + json gem crash fix (arm64)
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
| Contracts | `src/foundations/contracts/` | `ToolModule`, `Middleware`, presentation contracts |
| Settings schema | `src/foundations/settings-schema.ts` | 22 dot-key settings, validation, env vars |
| Config + models | `src/foundations/config.ts` + `models-catalog.ts` | Merge layers + catalog metadata accessors |
| Hashline | `src/foundations/hashline/` | Hash-anchored patch language: grammar, parser, patcher, snapshots |
| Tool executor | `src/domain/tool-executor.ts` | Registry, `tool()` factory, `resolveTools()`, groups |
| Permission system | `src/domain/permission.ts` + `grants.ts` | Policy decisions: what runs, when to ask, what to remember |
| Hooks | `src/domain/hooks.ts` | Safe executor — errors never crash the loop |
| Middleware pipeline | `src/domain/middleware/` | `compose()` chain: logging, rate-limit, auth, semantic-tools |
| Skill orchestration | `src/domain/skills/skill-invoker.ts` + `skill-catalog.ts` | Fill args, build prompt, switch provider |
| Streaming | `src/domain/streaming/` | Shared queue, async iterables, SSE |
| Sessions | `src/domain/sessions/session-store.ts` | `PersistenceBackend` factory + registry |
| Settings manager | `src/domain/settings/settings-manager.ts` | get/set/reset/list, persistence, masking |
| Provider runtime | `src/domain/providers/` | Runtime, config store, credential store, resolver, catalog |
| Provider controller | `src/transport/cli/provider-manager-api.ts` | Single semantic core for provider/account/slot management |
| Model manager dock | `src/ui/tui/overlays/model-manager.tsx` + `model-manager/` | Multi-tab TUI dock: purpose board, accounts, catalog browse, search (state hook, tabs, dialogs) |
| Model picker | `src/ui/tui/components/model-picker.tsx` | Search & filter model selector with reachability & pricing badges |
| Add account flow | `src/ui/tui/components/add-account.tsx` | Multi-credential account configuration (paste, env, none, oauth) |
| Setup wizard | `src/ui/tui/setup-wizard.tsx` | First-run onboarding wizard with preset bundles & slot recommendations |
| OAuth adapter | `src/vendors/pi-ai/pi-auth-adapter.ts` | Pi AI OAuth flow bridge over Seepient CredentialStore |
| Context accounting | `src/domain/context/` | Context-breakdown, message-convert |
| Inference adapters | `src/capabilities/inference/` | `AggregateInferenceAdapter` vendor routing |
| Tools | `src/capabilities/tools/` | 15 built-in tool modules: shell, files, web, email, widgets, todos… |
| Skills storage | `src/capabilities/skills/` | Registry, loader, parser, resolver, args |
| Gateway | `src/capabilities/gateway/` | MCP/OpenAPI client, scorer, tool factory |
| Tokenizer | `src/capabilities/tokenizer/` | `countTokens()` via `gpt-tokenizer` wrapper |
| System prompts | `src/domain/prompts/system-prompts.ts` | Interactive vs non-interactive |
| CLI UI entry | `src/ui/cli/index.ts` | Commander setup; dispatches TUI vs REPL |
| TUI | `src/ui/tui/` | Ink/React: components, widgets, diff, overlays, logo |
| REPL | `src/ui/repl/repl.ts` | Readline fallback, non-interactive / piped |
| CLI transport | `src/transport/cli/` | Bootstrap, setup, agent, config-loader, commands |
| HTTP transport | `src/transport/http/` | REST handlers, `provider-management/` routes (accounts, assignments, oauth, catalog), server core, standalone |
| WebSocket | `src/transport/ws/` | Dispatcher (`ws-handlers.ts`), `connection-registry.ts`, message handlers (`chat`, `approvals`, `provider-mutations`, `session-control`) |
| Auth | `src/transport/auth/` | API keys + scopes |
| SDK transport | `src/transport/sdk/` | `generateText`, `streamText`, `createAgent`, option resolution |

Unified provider architecture behind `ProviderRuntime` (`src/domain/providers/provider-runtime.ts`) and `AggregateInferenceAdapter` (`src/capabilities/inference/aggregate-adapter.ts`):

- **Inference Adapters**: Composable vendor backends (`PiLanguageRaw`, `PiImageRaw`, `GoogleImageRaw`, `OpenAIImageRaw`, `OmpCatalogSource`) under `src/vendors/`.
- **Purpose × Tier Routing**: Standard, complex, efficient tiers across language, vision, plan, commit, and image purposes.
- **Model Resolution**: Policy-driven selection over the community catalog (`@earendil-works/pi-ai` 0.84.2 + `@oh-my-pi/pi-catalog` lazy enrichment). Zero self-maintained model lists.

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

Env vars per provider: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GLM_API_KEY`, `OPENAI_COMPAT_API_KEY` + `OPENAI_COMPAT_BASE_URL`.

## Conventions

- **No bundler** — plain `tsc` to ES2022 NodeNext. Dev via `tsx`.
- **Package exports** — `seepient` (SDK), `seepient/server`. Binaries: `seepient` (CLI), `seepient-server`.
- **Vitest test suite** — 1370+ tests across 160 files; CI gates publish on test pass
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
- **ACTIVE PLAN**: `~/Documents/Obsidian/Seepient/Implementation-Specs/013-provider-management-tui/plan.md`
  — Provider management TUI (013): one shared, catalog-driven provider/model
  management experience over the existing v2 provider runtime (zero domain or
  schema changes). Shared ModelPicker + AddAccount components power the
  rebuilt in-TUI `/models` dock (jobs board with real pickers, live providers
  tab, capability/thinking gating, reachability dimming via `reachableVia`)
  and the rebuilt setup wizard (searchable catalog provider list, credential
  modes paste/env/keyless, extras via SettingsManager — deletes the hardcoded
  four-provider menu, discarded model answers, cycling picker, dead-end
  commands, silent save errors, and the extras settings-clobber bug). OAuth
  "Sign in with provider" (pi-ai flows: Claude Pro/Max, OpenRouter, Copilot,
  xAI, Kimi, Radius) folded in by owner amendment — `[4]` in the credential
  menu, tokens confined to the credential store (R14). Cross-surface parity
  (US8/M6): CLI (auth/providers/models browse/resolve, --json), server
  (catalog reachableVia, OAuth code-relay), SDK (instance methods) — one
  controller, four adapters, one vocabulary (R15). REPL
  `/models` rerouted to the same manager. Binding rules R1–R15 in plan.md;
  tasks T001–T064 in tasks.md (test-first, per-phase gates); UX contracts in
  contracts/ (provider-manager-api, model-manager-dock, setup-wizard,
  surface-parity).
- **IN-FLIGHT PLAN (implementation underway)**: `~/Documents/Obsidian/Seepient/Implementation-Specs/008-permission-system-redesign/plan.md`
  — Permission system redesign R9.1: analyzer-only tools, one Domain policy and
  execution boundary, native exact commits, typed effect/secret/model-egress
  brokers, external Docker worker scheduler (localhost mTLS in R9.1, multi-host
  post-R9.1), protected policy/audit stores with persisted replay ledger and
  durable outbox, atomic authority consumption (action/run/session lifetimes),
  and a governed self-evolution activation boundary. Six-item reviewer
  correction: see decisions D45–D47. Prior
  plan: `specs/007-tui-parity-upgrade/` (TUI parity — shipped).
- **IMPLEMENTED (Pending Merge)**: `~/Documents/Obsidian/Seepient/Implementation-Specs/015-god-file-decomposition/plan.md`
  — God-file decomposition (implemented; branch `015-god-file-decomposition`; P1 in the
  window after 014 merges and before 012 starts, P2 helper extraction):
  evidence-gated splits of four collision-prone files — `ws-handlers.ts` →
  message-family modules + `connection-registry.ts` (singletons move once),
  `provider-management-handlers.ts` → `provider-management/` route files (only
  importer `rest.ts` re-pointed), `model-manager.tsx` → `use-manager-state.ts`
  hook + tab components (parent path/exports preserved),
  `action-lifecycle.ts` → private-helper extraction only (pipeline never
  splits). Pure intra-layer moves, zero behavior change, no shims; safety =
  five existing suites (`architecture-boundaries`, `golden-parity`,
  `ws-approval`, `ws-provider-parity`, TUI + permission). Leave-alone list
  (`analyzers.ts`, `agent-loop.ts`, `pi-language-raw.ts`, `agent.ts`,
  `app.tsx`) and deferrals (`provider-runtime` → 012,
  `provider-manager-api` internals → forcing feature) recorded in
  research.md D1–D11.
- **UPCOMING (planned, not yet in implementation)**: `~/Documents/Obsidian/Seepient/Implementation-Specs/012-unified-media-generation-engine/plan.md`
  — Unified media generation engine (planned; starts after 010 lands on `main`,
  branch `012-media-engine`): extends the 010 provider architecture to image,
  video, speech, and transcription across four pillars — pi-ai (text, status
  quo), Vercel AI SDK (OpenAI/Gemini/local image + OpenAI TTS/STT with existing
  keys), `@fal-ai/client` (advanced media gateway via `fal.subscribe`
  passthrough), and local OpenAI-compatible endpoints (custom `baseURL`).
  Catalogs stay provider-owned: fal models via the fal Platform API v1,
  OpenAI/Google/local via `/v1/models` discovery plus a pattern-based
  capability classifier — zero curated media lists, user declarations as
  last-wins override. **Vendor-generic core ships as the standalone MIT
  package `seepient-unified-media-generation-provider` (own repo — see 012
  `package-charter.md`)**; Seepient integrates via thin `src/vendors/`
  wrappers (pi-ai pattern). Runtime media stubs become real attempt loops
  (video: 600 s budget); per-unit pricing wired; SDK methods
  `generateVideo`/`synthesizeSpeech`/`transcribe` published; legacy
  direct-OpenAI media paths deleted.
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
- **SHIPPED**: `~/Documents/Obsidian/Seepient/Implementation-Specs/010-provider-management-redesign/plan.md`
  — Provider management redesign (Shipped): Canonical inference contracts,
  normative v2 config schema with deep-patch overlay, aggregate inference
  adapter with vendor image composition (Pi, Google, OpenAI), instance-first
  async SDK v2 with event lifecycle, purpose × tier × thinking-level routing,
  multi-target retry with circuit-breaker cooldown, durable 0600 audit log with
  O_NOFOLLOW symlink rejection, SSRF validation, and TUI model manager.
<!-- SPECKIT END -->
