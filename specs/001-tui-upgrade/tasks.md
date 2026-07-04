---
description: "Task list for the Ink/React TUI upgrade feature"
---

# Tasks: TUI Upgrade (Ink/React)

**Input**: Design documents from `specs/001-tui-upgrade/` (plan.md, spec.md).
Authoritative PRD: `docs/tui-upgrade-prd.md`.

**Prerequisites**: plan.md (required), spec.md (required). No data-model.md,
contracts/, or research.md for this feature — tasks derive from the PRD's
feature-gap analysis and implementation phases.

**Tests**: Vitest is the project suite. Test tasks are OPTIONAL and included only
where the PRD defines an explicit verify gate or a regression risk (engine
changes in US2). Smoke/verify tasks are manual per the PRD's "Verify:" gates.

**Organization**: Tasks grouped by user story (US1-US4) mapped from the PRD's
implementation phases. Each story is independently testable.

## Format: `[ID] [P?] [Story?] Description with file path`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
  - Setup phase: NO story label
  - Foundational phase: NO story label
  - User Story phases: MUST have story label
  - Polish phase: NO story label
- Include exact file paths in descriptions

## Path Conventions

- Single project: `src/` at repository root. All TUI code lives under
  `src/adapters/cli/tui/`. Engine/provider changes touch `src/core/` and
  `src/providers/` (US2 only).
- Tests: `src/adapters/cli/tui/__tests__/` (Vitest). Existing baseline: 243 tests
  across 19 files (snapshot — treat as "all pre-existing tests"; the count drifts
  over time) — MUST stay green after every phase.

## Constitution Check (from plan.md)

All five principles compliant: TUI is CLI-adapter-only and drives
`Agent.chat({ onStep })` (US1) / `Agent.chatStream()` (US2) → shared
`runAgentLoop` (I); `@path` resolution consolidated to one call site, TUI dispatch
reuses the shipped `resolveLaunchMode()` (one launch-mode predicate), engine not
forked (II); theme starts inline, companions added only if they pass a smoke test,
`marked` removed, US1 uses the existing `onStep` path instead of pre-building
`chatStream` (III); readline and `setupInterrupt()` left intact for the fallback
path (IV); every phase has an explicit verify gate, `pnpm test` is a hard
regression gate (V).

## Phase 1: Setup (Project Initialization)

**Purpose**: Bring the Ink/React toolchain and TUI skeleton into the repo.

- [X] T001 Add `"jsx": "react-jsx"` to the `compilerOptions` of tsconfig.json (enables `.tsx` compilation under `tsc`; no bundler)
- [X] T002 [P] Run `pnpm add ink@6.6.0 react@^19.1.7` to add Ink + React 19 to package.json
- [X] T003 [P] Remove `marked` from package.json dependencies (grep confirms no import in `src/`; re-add when markdown rendering lands in US3)
- [X] T004 Create the `src/adapters/cli/tui/` directory tree with empty subdirectories `components/`, `overlays/`, `hooks/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Pre-flight gates and shared infrastructure that MUST be complete
before ANY user story can be implemented.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete. The
tsconfig JSX change (T001) must not break the existing tests; the companion
packages must render under React 19 before components depend on them; the shared
`bootstrapCliSession()` must exist before the TUI and readline diverge.

- [X] T005 Run `pnpm test` and confirm all pre-existing tests pass after the tsconfig `"jsx"` change (regression gate — fix any JSX-resolution failure before proceeding)
- [X] T006 Smoke-test Ink 6 + React 19: write a throwaway script that `render()`s `<TextInput/>` and `<SelectInput/>` (from `ink-text-input`, `ink-select-input`) plus `ink-spinner` and `terminal-link` against `ink@6.6.0` + `react@^19`. Keep the packages that render cleanly; for any that crash at runtime, plan ~50-line custom replacements and drop the package. Record the keep/replace decision
- [X] T007 Run `pnpm install` and confirm zero peer-dependency warnings (resolve any warning before proceeding — this is the PRD Phase-0 gate)
- [X] T008 Extract the shared session-setup phase from `runChat()` in src/adapters/cli/repl.ts into a new `bootstrapCliSession()` in src/adapters/cli/bootstrap.ts (config loading, provider resolution, skills init, gateway init, permissions — ~175 lines of setup in `runChat`). Both `runChat` (readline) and `startTui` call it. Do not duplicate setup across the two dispatch paths. Verify `seepient -n` is byte-identical immediately after this extraction, before any TUI wiring
- [X] T009 [P] Create src/adapters/cli/tui/theme.ts exporting the Tokyo Night Moon color tokens as a typed palette: `bg #222436`, `bgHighlight #2f334d`, `fg #c8d3f5`, `fgDim #828bb8`, `fgGutter #3b4261`, `blue #82aaff`, `cyan #86e1fc`, `green #c3e88d`, `yellow #ffc777`, `red #ff757f`, `purple #c099ff`, `orange #ff966c`

**Checkpoint**: Foundation ready — JSX compiles, companions validated, shared
bootstrap extracted, theme tokens defined. User story implementation can begin.

---

## Phase 3: User Story 1 - Interactive TUI Shell & Streaming (Priority: P1) 🎯 MVP

**Goal**: Launch `seepient` in a TTY into a full-screen Ink/React app that streams the
assistant response and renders tool execution as bordered blocks with inline
permission approval — while `seepient -n`, piped stdin, `--docker`, and SDK/Server
modes stay byte-identical.

**Independent Test**: Run `seepient` in a TTY, submit a prompt that triggers a shell
command — the tool block renders with output and the response streams. Run
`seepient -n` — readline path unchanged. `pnpm test` green.

**Engine note**: US1 needs NO new engine API. The loop's existing `onStep`
callback (PRD line 275) already emits `text` and `tool_call` steps — `use-agent`
drives the existing `Agent.chat({ onStep, approveTool, signal })`. The dedicated
`Agent.chatStream()` is deferred to US2, where token-level deltas justify it.

### Implementation for User Story 1

- [X] T010 [P] [US1] Create src/adapters/cli/tui/hooks/use-feed.ts — manages the feed array (append immutable entries on completion, update streaming entries by id)
- [X] T011 [P] [US1] Create src/adapters/cli/tui/hooks/use-agent.ts — agent state + `submit(input)` driving the existing `Agent.chat({ onStep, approveTool, signal })` (`onStep` → feed updates; interrupt via `agent.abort()`). Creates a `PromiseWithResolvers<boolean>` to bridge `approveTool` to the permission component. (US2 swaps `chat()` for `chatStream()` when token streaming lands.)
- [X] T012 [P] [US1] Create src/adapters/cli/tui/components/user-message.tsx — renders a user input entry (green token)
- [X] T013 [P] [US1] Create src/adapters/cli/tui/components/assistant-message.tsx — renders an LLM text response entry (blue token)
- [X] T014 [P] [US1] Create src/adapters/cli/tui/components/tool-call-block.tsx — bordered block: name/args header, status glyph (✓ ✗ ⏳), output buffer. Basic rendering here; expand/collapse + live output added in US2
- [X] T015 [P] [US1] Create src/adapters/cli/tui/components/permission-prompt.tsx — inline approval (tool name, args); calls the pending promise's `resolve(true/false)` on keypress. Stays within Ink input handling (no stdin mode switch)
- [X] T016 [P] [US1] Create src/adapters/cli/tui/components/error-message.tsx — renders error entries (red token)
- [X] T017 [US1] Create src/adapters/cli/tui/components/prompt-area.tsx — multi-line input, submit on Enter (depends on T011 use-agent)
- [X] T018 [US1] Create src/adapters/cli/tui/components/message-area.tsx — scrollable feed using Ink `Static` for immutable history + live components for streaming entries (depends on T010 use-feed, T012-T016)
- [X] T019 [US1] Create src/adapters/cli/tui/app.tsx — `TuiApp` root: `<Box flexDirection="column">` layout (`MessageArea` flex-grow + `PromptArea`); wires `use-agent` + `use-feed`; maps ESC/Ctrl+C → `agent.abort()` via Ink `useInput` (depends on T017, T018)
- [X] T020 [US1] Create src/adapters/cli/tui/index.ts — public entry `renderApp()` / `startTui({ agent, options, config, queryParts })` that calls Ink `render(<TuiApp .../>)`
- [X] T021 [US1] Add TUI/REPL dispatch to src/adapters/cli/index.ts — dispatch on `resolveLaunchMode(options) === 'interactive'` (the SAME function that selects the system prompt, so `--docker` / `SEEPIENT_NO_INTERACTIVE` / piped stdin never mis-launch the TUI); when interactive, dynamic `import('./tui/index.js')` and call `startTui`, otherwise call `runChat` (readline). Do NOT call `setupInterrupt()` in TUI mode (Ink owns raw stdin). Ship the "no React in headless" CI assertion (T055) with this commit, not later
- [X] T022 [US1] Consolidate `@path` reference resolution to one call site — resolve at the caller (`use-agent.ts` / `repl.ts`) and remove the duplicate `resolveReferences` call from `Agent.chat()` in src/adapters/cli/agent.ts (currently at `agent.ts:79-80` and `repl.ts:497`)
- [ ] T023 [US1] Verify (manual gate): `seepient` in a TTY renders the Ink TUI; `pnpm dev` (tsx) resolves the lazy `./tui/index.js` import against the `.tsx` source and renders identically; a shell-tool prompt renders the tool block with output; a custom-model skill switches provider and runs; `--moderate` destructive tool prompts inline; ESC/Ctrl+C aborts; `seepient --docker` and `seepient -n` keep the readline path; `pnpm test` passes

**Checkpoint**: US1 fully functional and testable independently — this is the MVP.

---

## Phase 4: User Story 2 - Autocomplete & Inline Interaction (Priority: P2)

**Goal**: Slash-command and `@mention`/file autocomplete dropdowns in the prompt,
expandable tool blocks with live output, and token-level streaming via an
additive `provider.chatStream()` + `text_delta` step on the shared engine — plus
the dedicated `Agent.chatStream()` that US1 deferred.

**Independent Test**: Type `/hel` → `/help` autocomplete. Type `@src/` → file list.
Ctrl+O → tool block expands. A provider with `chatStream()` streams tokens in real
time; non-streaming providers fall back to `chat()`.

### Implementation for User Story 2

- [X] T024 [P] [US2] Create src/adapters/cli/tui/components/autocomplete.tsx — fuzzy dropdown driven by Ink `useInput`; two sources: slash commands and files (`fs.readdir`/glob; `@alias/` scopes to a reference root). Slash-command source = the built-in command registry (`repl.ts:193-236`) + skill names; a `.seepient/commands/` custom-command loader is added ONLY if that mechanism is introduced (it does not exist today)
- [X] T025 [P] [US2] Create src/adapters/cli/tui/components/info-message.tsx — info/warning/status line entry
- [X] T026 [P] [US2] ~~Create src/adapters/cli/tui/components/bash-output.tsx~~ **Implemented without a separate component**: execute_shell_command now spawn-based, streams stdout via `ToolContext.onUpdate`; the loop emits `tool_progress` steps; `use-agent` renders a live `streamingTool` block (reuses `ToolCallBlock` status=running) that's superseded by the committed entry on completion. Verified by an engine test. — live shell stdout streaming for `execute_shell_command` tool blocks
- [X] T027 [US2] Extend src/adapters/cli/tui/components/prompt-area.tsx to wire autocomplete: type `/` → command dropdown, type `@` → file dropdown, fuzzy-filter as the user types (depends on T024)
- [X] T028 [US2] Extend src/adapters/cli/tui/components/tool-call-block.tsx with expand/collapse (default collapsed; Ctrl+O expands all) and live output via bash-output (depends on T026)
- [X] T029 [US2] Add an optional `chatStream()` method to the `LLMProvider` interface in src/providers/types.ts (returns an async iterator of streaming deltas)
- [X] T030 [P] [US2] Implement `chatStream()` in src/providers/openai.ts for OpenAI + OpenAI-compatible using the SDK's native streaming (~80 lines; depends on T029)
- [X] T031 [P] [US2] Implement `chatStream()` in src/providers/anthropic.ts for Anthropic + GLM using the SDK's native streaming (~80 lines; depends on T029)
- [X] T032 [US2] Add token-level streaming to `runAgentLoop` in src/core/agent-loop.ts — branch on `provider.chatStream()` availability at the single `currentProvider.chat(...)` call site (`agent-loop.ts:271`), iterate deltas, emit a new `text_delta` step type; add a `StreamingResponseAccumulator` to reconstruct incremental `tool_calls[].function.arguments` from fragmented provider streams (~50 lines) (depends on T029-T031)
- [X] T033 [US2] Add `text_delta` event handling in `StreamManager.toSSEStream()` in src/core/stream-manager.ts (~10 lines; for SDK/Server consumers) (depends on T032)
- [X] T034 [US2] ~~Create the `chatStream()` method on the `Agent` class~~ **Skipped per token-streaming mini-PRD §decision #4**: the in-process TUI drives the existing `Agent.chat({ onStep })` with `stream: true` (set in TUI mode), and `use-agent`'s `onStep` handles `text_delta` directly → React state. No separate `Agent.chatStream()` needed; SDK keeps its own. — wraps `runAgentLoop` and exposes step/delta updates to the TUI (~80-100 lines, accounting for instance-state wiring and TUI-wired `approveTool`). US1 proved the in-process TUI only needs an `onStep`/`onDelta` callback (not SSE), so forward deltas directly to React state rather than routing through `StreamManager` (which serves remote SDK/Server consumers). Prefer the direct-callback shape unless a concrete need for the iterable API emerges (depends on T029, T032)
- [X] T035 [US2] ~~Handle `text_delta` in `Agent.chatStream()`~~ **Folded into T034's approach**: `use-agent.ts` `onStep` accumulates `text_delta` into a live `streamingText` (rendered outside `<Static>`) and commits it to history on tool-call / turn end. in src/adapters/cli/agent.ts (~5 lines; depends on T033, T034)
- [X] T036 [US2] Handle `text_delta` in SDK `chatStream` `onStep` in src/adapters/sdk/agent.ts (~5 lines) and add the event to Server typing in src/adapters/server/ (~5 lines) (depends on T033)
- [ ] T037 [US2] Verify (manual gate): `/hel` → `/help`; `@src/` → file list; Ctrl+O expands tool blocks; a streaming provider shows per-token updates; a non-streaming provider falls back to the `chat()` path with no regression; `pnpm test` passes

**Checkpoint**: US2 fully functional and independently testable. Token streaming
is additive and backward-compatible — non-streaming providers and headless mode
are unaffected.

---

## Phase 5: User Story 3 - Quality-of-Life TUI (Priority: P3)

**Goal**: Command palette (Ctrl+P), keyboard shortcuts, a footer status bar with
live token/cost counts, Tokyo Night Moon theming across all components, and
markdown rendering for message content.

**Independent Test**: Ctrl+P opens the palette. Footer updates live during a run.
Themes apply consistently. A markdown response renders styled.

### Implementation for User Story 3

- [X] T038 [P] [US3] Create src/adapters/cli/tui/hooks/use-keybindings.ts — registers global shortcuts via Ink `useInput` (Ctrl+P palette, Ctrl+L clear, Ctrl+O expand, Ctrl+M model, Ctrl+E editor, Ctrl+C abort/clear, PageUp/Down scroll, ArrowUp history)
- [X] T039 [P] [US3] Create src/adapters/cli/tui/hooks/use-theme.ts — exposes the Tokyo Night Moon tokens via React context (consumes theme.ts from T009)
- [X] T040 [P] [US3] Create src/adapters/cli/tui/components/footer.tsx — fixed bottom `<Box>` status bar: `provider | model | tokens | cost | permission | skills | gw`; live counters via `use-agent`. (Live token/cost counters depend on US2's streaming + provider usage data being threaded to the CLI — confirm usage plumbing exists before wiring.)
- [X] T041 [P] [US3] Create src/adapters/cli/tui/overlays/command-palette.tsx — Ctrl+P modal `<Box>` with fuzzy command matching
- [X] T042 [P] [US3] Create src/adapters/cli/tui/overlays/model-selector.tsx — provider/model picker overlay (Ctrl+M)
- [X] T043 [P] [US3] Create src/adapters/cli/tui/overlays/help-dialog.tsx — keybinding reference overlay
- [X] T044 [US3] Create a markdown renderer in src/adapters/cli/tui/components/markdown.tsx — inline code, bold, lists, links. Either a custom renderer (~100 lines for the CommonMark subset Seepient needs) or `marked` + `marked-terminal` if the peer-version conflict is resolved (downgrade to `marked@^15` if compatible). Decide at kickoff (depends on T039 for theme tokens)
- [ ] T045 [US3] Wire `use-keybindings` + `footer` + overlays into `app.tsx` in src/adapters/cli/tui/app.tsx (depends on T038, T040, T041-T043)
- [X] T046 [US3] Apply theme tokens across all components via `use-theme()` in src/adapters/cli/tui/components/* (replace inline hex from US1 with the context) (depends on T039)
- [ ] T047 [US3] Verify (manual gate): Ctrl+P opens the palette; shortcuts fire; footer updates live during a run; themes apply consistently; markdown renders styled; `pnpm test` passes

**Checkpoint**: US3 fully functional and independently testable.

---

## Phase 6: User Story 4 - Advanced TUI (Priority: P4)

**Goal**: Todo/task list entries in the feed, a session management overlay, an
inline diff viewer for file edits, collapsible thinking blocks, and a file-watcher
footer notification. Each item is independent and opportunistic.

**Independent Test**: Trigger the todo tool → `<GoalStatus>` entries appear with
status glyphs. Open the session selector → list/preview/resume. Edit a file →
inline diff renders. `/thinking` → reasoning block toggles. Change a file
externally → footer notifies.

### Implementation for User Story 4

- [X] T048 [P] [US4] Create src/adapters/cli/tui/components/goal-status.tsx — todo/task entry with status glyphs (⬜ ⏳ ✅ ❌), persists across turns
- [ ] T049 [P] [US4] Create src/adapters/cli/tui/overlays/session-selector.tsx — flat/tree session list with fuzzy search, preview, delete/rename/export
- [X] T050 [P] [US4] Add a `manage_todos` tool (in src/tools/) that emits `<GoalStatus>` feed entries via a new step type; register it in the tool registry
- [ ] T051 [US4] Add an inline diff viewer for file-edit tools — extend src/adapters/cli/tui/components/tool-call-block.tsx or create src/adapters/cli/tui/components/diff-viewer.tsx
- [ ] T052 [US4] Add a collapsible reasoning/thinking block in src/adapters/cli/tui/components/reasoning-block.tsx, toggleable via a `/thinking` slash command
- [X] T053 [P] [US4] Add a file-watcher (e.g. `chokidar`) that surfaces a footer notification when project files change externally during a session — wire the notification into the US3 footer (T040)
- [ ] T054 [US4] Verify (manual gate): `manage_todos` updates glyphs; session selector lists/previews/resumes; a file edit renders an inline diff; `/thinking` toggles the reasoning block; an external file change fires the footer notification; `pnpm test` passes

**Checkpoint**: US4 fully functional and independently testable.

**Out of scope (deferred)**: Extension widget system (`setWidget()` API, PRD P2
#20). Not scheduled — revisit after US1-US4 if extension UI injection is needed.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Hardening that spans all user stories.

- [X] T055 [P] Add a CI assertion that React/JSX does not leak into headless builds — assert `dist/adapters/cli/repl.js` (and server/SDK outputs) contain no `jsx-runtime` reference. Add to the GitHub Actions workflow file. (Note: this assertion MUST accompany T021 — the first TUI/dispatch commit — not wait until Polish; T055 is the workflow-file landing only.)
- [ ] T056 [P] Add Ink `render()` tests for core components in src/adapters/cli/tui/__tests__/ (message-area, tool-call-block, prompt-area) using Ink's testing helpers
- [ ] T057 Run the full `pnpm test` suite; confirm all pre-existing (243) plus new TUI tests pass
- [ ] T058 [P] Update the docs/ VitePress CLI section to document interactive-TUI launch behavior (auto-detect via `resolveLaunchMode`), keybindings, and the `-n`/`--no-interactive`/`--docker` fallback
- [ ] T059 Run the spec.md acceptance scenarios for each completed user story as a final validation pass

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately. T001 (tsconfig)
  should land first so T005 can run.
- **Foundational (Phase 2)**: Depends on Setup. BLOCKS all user stories.
  T005-T007 are hard gates; T008 (bootstrap) and T009 (theme) are shared infra.
- **User Stories (Phase 3+)**: All depend on Foundational completion.
  - US1 is the MVP and the foundation for US2/US3/US4 (components + dispatch seam).
    US1 uses the existing `Agent.chat({ onStep })` — no new engine API.
  - US2 introduces `Agent.chatStream()` (T034) alongside `provider.chatStream()`
    (T029-T031) and loop integration (T032-T033). Token streaming is self-contained
    in US2 — it no longer depends on a US1 `chatStream` because US1 doesn't build one.
  - US3 and US4 add components onto US1's app shell (T019) and theme (T009).
- **Polish (Phase 7)**: T055 (CI assertion) lands with US1's dispatch (T021);
  T056/T057 are independent of US2-US4; T058/T059 run after the stories they
  document are complete.

### User Story Dependencies

- **US1 (P1)**: Starts after Foundational. No dependencies on other stories.
- **US2 (P2)**: Starts after Foundational. Autocomplete/tool-block tasks depend on
  US1's `prompt-area.tsx` (T017) and `tool-call-block.tsx` (T014); token streaming
  introduces `Agent.chatStream()` (T034) built on the provider interface (T029) and
  loop integration (T032). Should be independently testable after US1.
- **US3 (P3)**: Starts after Foundational. Overlays/shortcuts/theme wire into
  US1's `app.tsx` (T019). Independent of US2. (Footer live-counters consume US2
  streaming + usage data where available.)
- **US4 (P4)**: Starts after Foundational. `goal-status`/`diff`/`reasoning`/
  `file-watcher` are additive components. Independent of US2/US3 (file-watcher
  notification surfaces in the US3 footer).

### Within Each User Story

- Hooks before components that consume them (US1: T010/T011 before T017/T018).
- Components before the root `app.tsx` that composes them (US1: T012-T018 before T019).
- Engine interface before provider implementations before loop integration (US2:
  T029 before T030/T031 before T032; then T034 `Agent.chatStream()` after T029+T032;
  T035 after T034; T033/T036 hang off T032).
- Verify gate LAST in every story.

### Parallel Opportunities

- **Setup (Phase 1)**: T002, T003 run in parallel (different concerns, both touch
  package.json — coordinate the single write).
- **Foundational (Phase 2)**: T009 (theme.ts) is independent of T005-T008.
- **US1**: T010-T016 (2 hooks + 5 leaf components) all touch different files — run
  in parallel. T017-T020 are sequential (composition).
- **US2**: T024-T026 (autocomplete, info-message, bash-output) parallel.
  T030/T031 (OpenAI vs Anthropic chatStream) parallel.
- **US3**: T038-T043 (2 hooks + footer + 3 overlays) all parallel — different files.
- **US4**: T048-T050 + T053 (goal-status, session-selector, manage_todos,
  file-watcher) parallel.

---

## Parallel Example: User Story 1

```bash
# Launch the leaf components for User Story 1 together (different files):
Task: "Create use-feed hook in src/adapters/cli/tui/hooks/use-feed.ts"
Task: "Create use-agent hook in src/adapters/cli/tui/hooks/use-agent.ts"
Task: "Create user-message component in src/adapters/cli/tui/components/user-message.tsx"
Task: "Create assistant-message component in src/adapters/cli/tui/components/assistant-message.tsx"
Task: "Create tool-call-block component in src/adapters/cli/tui/components/tool-call-block.tsx"
Task: "Create permission-prompt component in src/adapters/cli/tui/components/permission-prompt.tsx"
Task: "Create error-message component in src/adapters/cli/tui/components/error-message.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T004)
2. Complete Phase 2: Foundational (T005-T009) — CRITICAL, blocks all stories
3. Complete Phase 3: User Story 1 (T010-T023)
4. **STOP and VALIDATE**: run the T023 verify gate (TUI renders, tools stream,
   permissions inline, headless unchanged, `pnpm dev` resolves `.tsx`, `pnpm test` green)
5. Ship/demo the interactive TUI MVP

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. Add US1 → verify independently → ship MVP (interactive shell + streaming + tools)
3. Add US2 → verify independently → ship autocomplete + token streaming
4. Add US3 → verify independently → ship palette/shortcuts/footer/theme/markdown
5. Add US4 → verify independently → ship todos/session/diff/thinking/file-watcher
6. Each story adds value without breaking previous stories or headless mode

### Fallback (per PRD §Risks-4)

If Phase 1 (US1) drags, fall back to the 90/10 path: keep readline + add
Ink-rendered tool blocks only (no full alternate-screen app). Ship tool visibility
sooner, return to the full-Ink app after.

---

## Notes

- `[P]` tasks = different files, no dependencies on incomplete tasks
- `[Story]` label maps a task to its user story for traceability
- Every user story ends with a manual verify gate (T023, T037, T047, T054) — these
  are the PRD's explicit "Verify:" gates, not optional
- `pnpm test` (T005, T037, T047, T054, T057) is a hard regression gate after every
  engine-touching phase — the pre-existing suite (snapshot: 243 tests) MUST stay green
- US1 adds NO engine surface — it wires the existing `Agent.chat({ onStep })` path
  (PRD line 275: `onStep` is sufficient). `Agent.chatStream()` (T034) lands in US2
  where token-level deltas justify it
- Engine changes (US2, T029-T036) are additive and backward-compatible: a provider
  without `chatStream()` falls back to `chat()`; headless/SDK/Server are unaffected
- TUI dispatch (T021) MUST use the shipped `resolveLaunchMode()` — the same predicate
  that selects the system prompt — never a separate `isTTY && interactive` check
- Out of scope: Extension widget system (`setWidget()` API, PRD P2 #20)
- Commit after each task or logical group; stop at any checkpoint to validate a
  story independently
- Avoid: vague tasks, same-file parallel conflicts, cross-story dependencies that
  break independence
