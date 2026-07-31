# Feature Specification: TUI Upgrade (Ink/React)

**Feature Branch**: `001-tui-upgrade`

**Created**: 2026-06-13

**Status**: Draft

**Source**: `docs/tui-upgrade-prd.md` (authoritative PRD; this spec extracts the
user stories for task generation).

## User Scenarios & Testing

### User Story 1 - Interactive TUI Shell & Streaming (Priority: P1)

Launch the agent with plain `seepient` in a TTY and get a full-screen Ink/React app
that streams the assistant's response live, renders every tool execution as a
bordered block with live output, and asks for tool approval inline — while
`seepient -n`, piped stdin, `--docker`, and SDK/Server modes behave byte-identically
to before.

**Why this priority**: This is the MVP. Without it the interactive CLI is still
the readline/chalk REPL. It establishes the component model, the lazy-load seam,
and the `Agent.chat({ onStep })` → React-state bridge that every later story
builds on (PRD line 275: the loop's existing `onStep` callback is sufficient for
Phase 1 — no new engine API). The PRD scopes Phase 1 to 7 components + 2 hooks;
`Agent.chatStream()` is deferred to US2, where token-level streaming justifies it.

**Independent Test**: Run `seepient` in a TTY, submit a prompt that triggers a shell
command — the tool block renders with streaming output and the assistant
response streams in. Run `seepient -n` and confirm the readline path is unchanged.
Run `pnpm test` and confirm all pre-existing tests still pass after the tsconfig
JSX change.

**Acceptance Scenarios**:

1. **Given** a TTY terminal, **When** the user runs `seepient`, **Then** an Ink
   full-screen app renders (`<MessageArea>` + `<PromptArea>`), not the readline
   prompt.
2. **Given** the TUI is open, **When** the user submits a prompt that triggers a
   shell tool call, **Then** a bordered `<ToolCallBlock>` renders with the tool
   name/args header and live stdout.
3. **Given** a destructive tool under `--moderate`, **When** the tool is about to
   run, **Then** an inline `<PermissionPrompt>` asks y/n and the agent waits on
   the user's keypress without switching stdin mode.
4. **Given** a skill with a custom model, **When** invoked, **Then** the provider
   switches and the run completes identically to headless (skills/permissions/
   gateway all work).
5. **Given** non-interactive conditions (`-n`, piped stdin, `--docker`), **When**
   launched, **Then** the readline path runs and React/Ink are never imported.
6. **Given** the agent is running, **When** the user presses ESC/Ctrl+C, **Then**
   the in-flight request aborts (Ink maps the key to `agent.abort()`).

---

### User Story 2 - Autocomplete & Inline Interaction (Priority: P2)

In the prompt, typing `/` shows a fuzzy-filtered slash-command dropdown and
typing `@` shows a fuzzy file-search dropdown; tool-call blocks expand/collapse;
permission prompts render inline in the feed.

**Why this priority**: Discovery and visibility are the structural gaps the
chalk REPL cannot deliver (PRD P0 items 3, 4, 5, 7). Builds directly on the US1
component model. Token-level streaming (`provider.chatStream()` + `text_delta`)
also lands here as the cross-cutting engine enhancement.

**Independent Test**: Type `/hel` → autocomplete shows `/help`. Type `@src/` → a
file list filters. Trigger a tool call and press Ctrl+O → its block expands. A
destructive tool renders an inline permission prompt.

**Acceptance Scenarios**:

1. **Given** the prompt is focused, **When** the user types `/`, **Then** a
   dropdown of slash commands appears, fuzzy-filtered as they type. Sources: the
   built-in command registry + skill names (a `.seepient/commands/` custom-command
   loader is added only if that mechanism is introduced).
2. **Given** the prompt is focused, **When** the user types `@`, **Then** a
   fuzzy file-search dropdown appears (project files; `@alias/` scopes to a root).
3. **Given** a completed tool call block, **When** the user toggles expand, **Then**
   the full output shows/collapses (default collapsed).
4. **Given** a tool needing approval, **When** it is about to run, **Then** the
   permission prompt renders inline in the feed (tool name, args, risk level)
   with y/n/a keys.
5. **Given** `provider.chatStream()` is available (Phase 2 engine work), **When**
   the assistant responds, **Then** individual tokens stream into the message in
   real time via `text_delta` steps.

---

### User Story 3 - Quality-of-Life TUI (Priority: P3)

A command palette (Ctrl+P), keyboard shortcuts, a footer status bar with live
token/cost counts, Tokyo Night Moon theming applied across components, and
markdown rendering for message content.

**Why this priority**: Polishes the interactive experience into a first-class
developer tool. All additive components on the US1/US2 foundation. None block
core functionality.

**Independent Test**: Press Ctrl+P → palette opens with fuzzy command match. Watch
the footer during a run → token/cost counters update live. Toggle theme tokens
→ all components re-color. Send a markdown response → it renders styled.

**Acceptance Scenarios**:

1. **Given** the TUI is idle, **When** the user presses Ctrl+P, **Then** a
   command-palette overlay opens with fuzzy search.
2. **Given** the documented shortcuts (Ctrl+L clear, Ctrl+O expand, Ctrl+M model,
   Ctrl+E editor, Ctrl+C abort/clear), **When** pressed, **Then** the action fires.
3. **Given** a run in progress, **When** tokens accrue, **Then** the footer status
   bar updates live (provider | model | tokens | cost | permission | skills | gw).
4. **Given** Tokyo Night Moon tokens, **When** components render, **Then** colors
   come from `useTheme()` consistently across all components.
5. **Given** an assistant message with markdown, **When** rendered, **Then** inline
   code, bold, lists, and links display as ANSI-styled (custom renderer or resolved
   `marked`/`marked-terminal` peer).

---

### User Story 4 - Advanced TUI (Priority: P4)

Todo/task list entries in the feed (via a `manage_todos` tool), a session
management overlay, an inline diff viewer for file edits, collapsible thinking
blocks, and a file-watcher footer notification.

**Why this priority**: Differentiators. Each is independent and opportunistic
(PRD P2 items 14-20). Ship incrementally after the core TUI is solid.

**Independent Test**: Trigger the todo tool → `<GoalStatus>` entries appear with
pending/done glyphs. Open the session selector → list/preview/resume. Edit a file
→ inline diff renders. `/thinking` → reasoning block toggles.

**Acceptance Scenarios**:

1. **Given** the agent manages todos, **When** status changes, **Then** feed
   `<GoalStatus>` entries update glyphs (⬜ ⏳ ✅ ❌).
2. **Given** the session selector, **When** opened, **Then** sessions list with
   fuzzy search, preview, delete/rename/export.
3. **Given** a file-edit tool runs, **When** it completes, **Then** an inline diff
   viewer renders the change.
4. **Given** a reasoning model, **When** `/thinking` is toggled, **Then** a
   collapsible reasoning block renders/hidden.
5. **Given** an external file changes during a session, **When** the watcher
   fires, **Then** a footer notification surfaces the change.

**Out of scope (deferred)**: Extension widget system (`setWidget()` API, PRD P2
#20). Not scheduled in US1-US4.

### Edge Cases

- What happens when the terminal is too narrow for the bordered blocks? (Wrap or
  truncate; Ink flexbox handles, but verify at 80 cols.)
- What happens if a companion package (`ink-text-input`/`ink-select-input`)
  crashes at runtime under React 19? (Phase 0 smoke test; fall back to ~50-line
  custom components.)
- What happens if `provider.chatStream()` is unavailable for a provider? (Loop
  must fall back to the non-streaming `chat()` path — `text_delta` is opt-in.)
- How does abort interact with an outstanding inline `<PermissionPrompt>` promise?
  (Stale resolvers must be GC'd on abort.)
- What happens when `pnpm dev` (tsx) resolves the lazy `import('./tui/index.js')`?
  (The source is `.tsx`; verify tsx maps the `.js` specifier, or the primary
  interactive dev loop breaks on the first US1 commit.)

## Requirements

### Functional Requirements

- **FR-001**: The CLI MUST launch the Ink/React TUI iff
  `resolveLaunchMode(options) === 'interactive'` — the SAME function that selects
  the system prompt — so launch mode and UI mode can never diverge. This composes
  `options.interactive !== false && !isNonInteractive()` (TTY + `--no-interactive`
  + piped stdin + `--docker` + `SEEPIENT_NO_INTERACTIVE`); all non-interactive launch
  paths MUST use the unchanged readline path.
- **FR-002**: The TUI MUST obtain responses through the shared `runAgentLoop` and
  MUST NOT bypass the engine. US1 uses the existing `Agent.chat({ onStep,
  approveTool, signal })` path (step-level streaming via the loop's `onStep`
  callback — no new API); US2 adds `Agent.chatStream()` for token-level deltas.
  Both wrap the single engine.
- **FR-003**: React/Ink MUST be lazy-loaded via dynamic import; headless builds
  MUST NOT statically import any `.tsx`.
- **FR-004**: The TUI MUST render each tool call as a bordered block with a
  name/args header, status glyph, and live/expandable output.
- **FR-005**: Destructive tools requiring approval MUST render an inline
  permission prompt and pause the agent on a Promise resolved by the user's
  keypress.
- **FR-006**: ESC/Ctrl+C in TUI mode MUST call `agent.abort()`; `setupInterrupt()`
  MUST NOT be called in TUI mode.
- **FR-007**: `pnpm test` MUST pass (all pre-existing tests) after every phase;
  the tsconfig JSX change MUST not break compilation.
- **FR-008**: `@path` reference resolution MUST happen at exactly one call site
  (the caller), consolidated from the current two.

### Key Entities

- **FeedEntry**: a message/tool/permission/error entry in the scrollable history
  (maps to a React component; immutable once complete).
- **ToolCallBlock state**: tool name, args, status (pending/running/ok/fail),
  output buffer, expanded flag, duration.
- **PendingPermission**: a `PromiseWithResolvers<boolean>` bridging
  `runAgentLoop`'s `approveTool` to the `<PermissionPrompt>` component.

## Success Criteria

### Measurable Outcomes

- **SC-001**: "type `/` and see options" (no `/help` needed) — US2.
- **SC-002**: "live streaming output in bordered blocks" (vs current gray text,
  no output) — US1/US2.
- **SC-003**: "@fuzzy-path-completion" (vs type full paths from memory) — US2.
- **SC-004**: "live todo list with status glyphs" (vs no visibility) — US4.
- **SC-005**: "real-time token streaming + markdown" (vs spinner then dump) —
  US2/US3.
- **SC-006**: "identical experience on macOS, Linux, Docker, Windows" (vs
  macOS-only native addon) — US1 (lazy-load + no native deps).

## Assumptions

- React 19 + Ink 6.6.0 are production-ready for CLI use (fallback: Ink 5 +
  React 18 if stability issues arise).
- The Ink companion packages (`ink-text-input`, `ink-select-input`,
  `ink-spinner`, `terminal-link`) satisfy their declared `ink>=5` / `react>=18`
  peers; runtime compatibility is verified by the Phase 0 smoke test.
- Token-level streaming (Phase 2) is an additive, backward-compatible engine
  enhancement that does not alter non-streaming behavior.
- The current Vitest suite is the regression baseline (snapshot: 243 tests across
  19 files at the time of writing — treat as "all pre-existing tests" since the
  count drifts as features land).
