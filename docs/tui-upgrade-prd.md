# Seepient TUI Upgrade PRD

## Technology Decision: Ink/React (npm dependency)

**Final verdict:**

| Factor | Ink/React (chosen) | Pi TUI (rejected) |
|--------|-------------------|-------------------|
| **Platform** | Pure JS — macOS, Linux, Docker, Windows, CI | Contains compiled C native addon (`darwin-modifiers.node`), **no Linux prebuilds** |
| **Build integration** | `pnpm add ink react` — done | Requires native prebuild shipping, build step beyond `tsc` |
| **Seepient "Docker-native"** | Identical everywhere | macOS-only native modifier; Linux silently degrades |
| **Dependency surface** | React 19, Ink 6.6.0, 3 Ink plugins, ~10 TUI utility packages | 2 npm deps (`marked`, `get-east-asian-width`) + per-platform native binaries |
| **Component model** | JSX, React hooks — well-known hiring pool | Custom `Component` interface: `render(width): string[]` |
| **Existing reference** | Command Code v0.37.2 (1.5MB bundle) installed on dev machine — proven component patterns | Pi agent's interactive mode |
| **Maintenance** | React/Ink are stable, well-maintained, widely used | Maintaining vendor fork + native build pipeline |

We evaluated using Pi TUI via its published npm package (`@earendil-works/pi-tui` v0.79.3) — the simpler alternative to vendoring. Rejected because: (1) it ships a compiled C native addon with no Linux prebuilds, which is incompatible with Seepient's Docker-native identity; (2) it requires build infrastructure beyond `tsc` to ship prebuilds; (3) the native modifier module is macOS-only, silently returning `undefined` on Linux/Docker.

**Chosen approach:** Add Ink 6.6.0 + React 19 as npm dependencies. Build our own TUI component library (`src/adapters/cli/tui/`) using the same technology stack as Command Code but with Seepient-specific architecture and Tokyo Night Moon theming. Lazy-load the TUI module only in interactive mode — headless/CI/Docker modes never import React.

**Streaming architecture decision:**

| Approach | Evaluated? | Verdict |
|----------|-----------|---------|
| **Bypass runAgentLoop** (Agent.chatStream → provider.chatStream → TUI) | Yes | Rejected. Loses tool execution, skills, permissions, gateway injection, and all hooks. Violates "single execution engine" invariant. |
| **Reuse runAgentLoop + StreamManager** (mirror SDK's chatStream) | Yes — **chosen** | Wraps runAgentLoop in background, pipes onStep → StreamManager. Zero engine divergence. Tool execution, skills, permissions, gateway all work identically in interactive and headless mode. |
| **New parallel loop** (rewrite tool execution, permissions, etc.) | Yes | Rejected. Hundreds of lines of duplicated logic. Guaranteed behavioral divergence. |

The chosen pattern ships today in `src/adapters/sdk/agent.ts::chatStream()`. The CLI Agent follows the same architecture — wraps `runAgentLoop` in a background loop, pipes `onStep` events into `StreamManager`. The wiring differs from the SDK because the CLI Agent holds state as instance fields (`this.messages`, `this._middleware`, `this.skillCatalog`, `this.autoConfirm`) rather than closure variables, and additionally bridges `approveTool` to the TUI's inline permission prompt. `@path` resolution is consolidated to the caller in Phase 1 (see §Feature Gap #2), so neither `Agent.chat()` nor `Agent.chatStream()` resolves references. `Agent.chatStream()` lands in **Phase 2** at ~80-100 lines (instance-state wiring + TUI-wired `approveTool`); Phase 1 renders via the existing `Agent.chat({ onStep })` path. Because the TUI is in-process, `Agent.chatStream()` may expose deltas through a direct `onStep`/`onDelta` callback rather than routing through `StreamManager` (which exists to serve remote SDK/Server consumers) — decide at Phase-2 kickoff.

---

## Reference: Command Code Component Inventory

Command Code v0.37.2 (installed at `/opt/homebrew/lib/node_modules/command-code/`) provides a proven reference architecture. From analysis of the 1.5MB bundled `dist/index.mjs`, the component hierarchy is:

### Message Components (feed entries)
| Component | Purpose | Seepient equivalent needed? |
|-----------|---------|-------------------------|
| `UserMessage` | User chat messages | Yes |
| `AssistantMessage` | LLM response (text + tool calls) | Yes |
| `ToolMessage` | Tool execution block (command/result) | Yes — renamed `ToolCallBlock` |
| `BashMessage` | Shell command with output streaming | Yes — merged into `ToolCallBlock` |
| `ReasoningMessage` | Thinking/reasoning block (collapsible) | Yes |
| `ErrorMessage` | Error display | Yes |
| `InfoMessage` | Info/warning/status | Yes |
| `StatusMessage` | Agent status (running, completed) | Yes |
| `GoalStatusMessage` | Todo/task status (pending/doing/done) | Yes |
| `GoalCompleteMessage` | Task completion marker | Yes |
| `ContextMessage` | Context usage notification | Merge into footer |
| `StartupMessage` | Startup banner | Condense into footer |
| `HookFrameMessage` | Hook execution frame | Reuse for skill hooks |
| `AutoCompactMessage` | Auto-compact notification | Yes |
| `SystemMessage` | System-level messages | Yes |

### Overlay Components
| Component | Purpose | Seepient equivalent needed? |
|-----------|---------|-------------------------|
| Model selector | Provider/model picker overlay | Yes |
| Provider selector | Auth/provider connection dialog | Yes |
| Session selector/list | Browse/resume sessions | Yes — P1 |
| Command palette | Ctrl+P searchable commands | Yes |
| Permission prompt | Inline tool approval | Yes |
| Question prompt | Interactive agent questions | Yes |
| Help overlay | Keybinding reference | Yes |
| Settings list | Configuration editing | Yes |
| Export options | Session export dialog | P2 |
| Diff viewer | Inline diff display | P2 |

### Layout Components
| Component | Purpose | Seepient equivalent needed? |
|-----------|---------|-------------------------|
| Feed | Scrollable message list | Yes — `MessageArea` |
| Live entries | Streaming/active entries | Yes — merged into `MessageArea` |
| Prompt/input | Multi-line editor with autocomplete | Yes — `PromptArea` |
| Footer | Status bar | Yes |
| Learning feed toggle | Taste learning sidebar | Not applicable (Seepient has no taste system) |

### Render Utilities
| Utility | Purpose |
|---------|---------|
| `renderToolHeader` | Bordered tool call header with name + args |
| `renderTruncatedOutput` | Expandable/collapsible tool output |
| `renderEditFileDiff` | Inline file edit diff display |
| `renderReadToolInlineSummary` | Read file inline preview |
| `renderWriteFileContent` | Write file preview |
| `renderAgentStatus` | Status bar component |
| `renderHookOutcome` | Hook result display |
| `renderContextGroup` | Context file grouping |
| `renderProgressUI` | Progress spinner with message |
| `renderStackedTable` | Key-value table rendering |

### Key Insights from Command Code's Architecture

1. **Feed-based rendering model**: Messages stream into a feed array. The TUI renders feed entries top-to-bottom with `ink`'s `Static` component for immutable history + live components for active/streaming items.

2. **Tool calls are component-level**: Each tool call is a distinct component with its own state (expanded/collapsed, status glyph, live output buffer). Not a generic text block.

3. **Permission prompts are part of the feed, not modal**: Approval requests appear inline in the message stream rather than as separate modal overlays. This avoids breaking the user's visual flow.

4. **Context is tracked explicitly**: A context engine tracks files/skills/commands added to context and renders them as context blocks.

5. **Autocomplete is prompt-local**: File paths, slash commands, and agent mentions autocomplete within the prompt input using Ink's `useInput` hook — not as a separate overlay.

---

## Seepient Architecture Integration

The TUI lives entirely within the **CLI adapter layer** in Phase 1. Phase 2 is an additive, backward-compatible enhancement to the shared engine (new optional `chatStream()` + `text_delta` step type), consistent with the `runAgentLoop` invariant.

### Launch Behavior

**One binary, auto-detected mode.** No separate `seepient-tui` command. No `--tui` flag.

| Condition | Launches | Stack loaded |
|-----------|----------|-------------|
| `seepient` in a TTY terminal (default) | Ink/React TUI | React 19 + Ink 6.6.0 (via dynamic import) |
| `seepient -n` / `--no-interactive` | Readline REPL | `chalk` + `readline` + `inquirer` (existing) |
| `seepient` with piped stdin | Readline REPL | `chalk` + `readline` + `inquirer` (existing) |
| `seepient --docker` | Readline REPL | `chalk` + `readline` + `inquirer` (existing) |
| `pnpm dev` (interactive) | Ink/React TUI | React 19 + Ink 6.6.0 (via dynamic import) |

**`--headless` semantics:** `--headless` means "auto-approve all tools" (bypass the permission matrix) — it is not a non-interactive flag. `--no-interactive` / `-n` is the non-interactive flag. The TUI must still render tool blocks without prompts when `--headless`/`--yolo` is active; it's a permission behavior, not a UI choice.

The decision is made in `index.ts` at startup — before any TUI modules are imported. Headless/CI/Docker modes never load React or Ink into memory.

**Before (current):**
```
src/adapters/cli/
├── index.ts           → Commander setup
├── repl.ts            → runChat(): readline loop + chalk/inquirer
├── agent.ts           → Agent class (wraps runAgentLoop)
├── system-prompts.ts  → ✅ SHIPPED — dual prompts (interactive/headless) + resolveLaunchMode()
├── setup.ts           → Setup wizard
├── config-loader.ts   → Config loading
├── docker-utils.ts    → Docker detection
└── commands/          → Slash command handlers
```

**After (target):**
```
src/adapters/cli/
├── index.ts           → ✅ EXISTS + 🔲 Phase 1 — add TUI/REPL dispatch
├── repl.ts            → ✅ EXISTS — readline fallback for non-interactive
├── agent.ts           → ✅ EXISTS + 🔲 Phase 2 — add chatStream() (Phase 1 uses existing chat({onStep}))
├── system-prompts.ts  → ✅ SHIPPED — no changes needed
├── setup.ts           → ✅ SHIPPED — unchanged
├── config-loader.ts   → ✅ SHIPPED — unchanged
├── docker-utils.ts    → ✅ SHIPPED — unchanged
├── tui/               → 🔲 Phase 1 — NEW, lazy-loaded
│   ├── app.tsx        → 🔲 P1  TuiApp: root component
│   ├── components/
│   │   ├── message-area.tsx    → 🔲 P1  Scrollable feed of messages
│   │   ├── user-message.tsx    → 🔲 P1  User input display
│   │   ├── assistant-message.tsx → 🔲 P1  LLM response display
│   │   ├── tool-call-block.tsx → 🔲 P1  Bordered tool execution (expandable, streaming)
│   │   ├── prompt-area.tsx     → 🔲 P1  Multi-line input
│   │   ├── permission-prompt.tsx → 🔲 P1  Inline tool approval
│   │   ├── error-message.tsx   → 🔲 P1  Error display
│   │   ├── info-message.tsx    → 🔲 P2  Info/warning/status line
│   │   ├── autocomplete.tsx    → 🔲 P2  Fuzzy file/command suggestion dropdown
│   │   ├── bash-output.tsx     → 🔲 P2  Live shell stdout
│   │   ├── footer.tsx          → 🔲 P2  Status bar with live tokens
│   │   ├── reasoning-block.tsx → 🔲 P4  Collapsible reasoning
│   │   └── goal-status.tsx     → 🔲 P4  Todo/task status entry
│   ├── overlays/
│   │   ├── command-palette.tsx  → 🔲 P3 Ctrl+P searchable commands
│   │   ├── model-selector.tsx   → 🔲 P3 Provider/model picker
│   │   ├── session-selector.tsx → 🔲 P4 Tree-view session browser
│   │   └── help-dialog.tsx      → 🔲 P3 Keybinding reference
│   ├── hooks/
│   │   ├── use-agent.ts        → 🔲 P1  Agent state, submit, interrupt
│   │   ├── use-feed.ts         → 🔲 P1  Message feed management
│   │   ├── use-keybindings.ts  → 🔲 P3  Keyboard shortcut registration
│   │   └── use-theme.ts        → 🔲 P3  Tokyo Night Moon color tokens
│   ├── theme.ts         → 🔲 P2  Color palette (start with inline hex in P1)
│   └── index.ts         → 🔲 P1  Public entry: renderApp(agent, options)
└── commands/          → ✅ SHIPPED — unchanged
```

**Phase 1 delivers 7 components + 2 hooks** (`app.tsx`, `message-area.tsx`, `user-message.tsx`, `assistant-message.tsx`, `tool-call-block.tsx`, `prompt-area.tsx`, `permission-prompt.tsx`, `error-message.tsx` + `use-agent.ts`, `use-feed.ts`). Theme starts as inline hex values (no hook). Footer, info-message, bash-output, and autocomplete gate to Phase 2.

**Scope justification.** Seepient's product identity is headless-first/Docker-native, but the interactive CLI is the primary developer touchpoint — onboarding, debugging, skill authoring, and ad-hoc exploration all happen there. The TUI is not a "pretty REPL" — streaming tool blocks, inline permission prompts, and autocomplete are productivity features that the chalk+inquirer REPL structurally cannot deliver. The architecture keeps headless mode identical (no React loaded, no engine changes) while investing in the interactive path. Later phases add features opportunistically; Phase 1 targets the minimum viable interactive experience.

**Lazy loading pattern (in `index.ts`):**

```typescript
// index.ts — CLI entry point
const { options, queryParts } = parseArgs();

if (resolveLaunchMode(options) === 'interactive') {
  // Dynamic import — React/Ink not loaded in headless/CI/Docker mode.
  // resolveLaunchMode composes TTY + --no-interactive + piped stdin + --docker +
  // SEEPIENT_NO_INTERACTIVE — the SAME predicate that selects the system prompt,
  // so launch mode and UI mode can never diverge.
  const { startTui } = await import('./tui/index.js');
  await startTui({ queryParts, options, config, agent, ... });
} else {
  // Readline fallback for non-interactive mode
  await runChat(queryParts, options);
}
```

This satisfies the Seepient convention of **dynamic provider imports** (unused modules stay out of memory) — the entire TUI module (~15 components + React + Ink) is only loaded when the user explicitly runs in interactive mode.

**Input ownership: TUI vs. readline.** The current REPL owns stdin via `stdin.setRawMode(true)` and listens for ESC to abort (repl.ts:67-88). Ink's `useInput` hook also takes raw stdin. Two raw-mode listeners on one stdin cause dropped/duplicated keypresses and broken Ctrl+C. In TUI mode, `setupInterrupt()` must not be called — its stdin listener and `InterruptHandle` exist only for the readline fallback. The TUI maps ESC/Ctrl+C → `agent.abort()` via `use-keybindings.ts`, calling the existing `abortController` directly. The `InterruptHandle.suspend/resume` mechanism (for freeing stdin during `inquirer` prompts) disappears — `approveTool` in TUI mode calls the TUI's `<PermissionPrompt>` component, which uses Ink's input handling. `setupInterrupt` stays untouched in `repl.ts` for the readline fallback path.

**System prompt by launch mode.** The current single system prompt ("Docker-Native Autonomous Agent … worker unit, not a chat bot") is correct for headless/SDK/Docker but wrong for an interactive TUI session. Two prompts now exist in `src/adapters/cli/system-prompts.ts`, selected at launch:

| Launch | Prompt |
|---|---|
| Interactive (TUI, or interactive readline in a TTY) | `buildInteractiveSystemPrompt()` — a coding-agent prompt: explicit tool list, working principles (think-before-coding, surgical changes, simplicity, goal-driven), an understand→plan→act→verify process, and concise output rules. Style follows the interactive-agent conventions shared by Command Code; principles mirror this project's own `AGENTS.md`. |
| Non-interactive (headless, piped, `--no-interactive`, `--docker`) | `buildSystemPrompt()` — the original Docker-native prompt, **byte-identical to before**. |
| SDK / Server | Unchanged. SDK defaults to a generic string or the caller-supplied `systemPrompt`; Server supplies none. |

Mode detection (`resolveLaunchMode(options)`) composes the CLI's two existing signals rather than introducing a new one: `interactive ⟺ options.interactive !== false && !isNonInteractive()`. This matches every launch path — plain `seepient` in a TTY → interactive; `--no-interactive`, piped stdin, `--docker`, `SEEPIENT_NO_INTERACTIVE` → non-interactive. `repl.ts` calls `selectSystemPrompt(resolveLaunchMode(options))` and passes the result as a new optional 4th argument to `new Agent(provider, model, config, systemPrompt)`. The `Agent` defaults to the headless prompt when none is passed, and `clearConversation()` restores whatever prompt it was constructed with. Core's `runAgentLoop` is untouched — it only receives the selected string, so launch mode never leaks below the CLI adapter layer. `/compact` preserves the agent's current system message (its `buildSystemPrompt` fallback was repointed to the new file; behavior unchanged).

---

## Dependencies

```bash
pnpm add ink@6.6.0 react@^19.1.7 \
  ink-spinner@^5.0.0 \
  ink-select-input@^6.2.0 \
  ink-text-input@^6.0.0 \
  terminal-link@^5.0.0
```

**`marked` / `marked-terminal` — deferred.** `package.json` already pins `marked@^18.0.5`. `marked-terminal@7.3.0` declares `peer: marked >=1 <16` — incompatible with `marked@^18`. Resolution options (decide at Phase-1 kickoff):

| Option | How | Risk |
|--------|-----|------|
| Downgrade to `marked@^15` | `pnpm add marked@^15 marked-terminal@^7.3.0` | Loses `marked@^18` (currently unused — no import in `src/`). Straightforward. |
| Custom ANSI renderer | Write a small `markdown.tsx` that handles inline code, bold, lists, links directly | No dep risk. Under 100 lines for the subset Seepient needs. |
| Wait for `marked-terminal` v8 | Track `mikaelbr/marked-terminal#375` (open for marked 16/17/18 support) | Unknown timeline. |

**Phase-0 gate:** `pnpm install` produces zero peer warnings. No marked/marked-terminal version added until resolved.

**Ink companion package verification.** `ink-text-input@6.0.0` and `ink-select-input@6.2.0` were published May 2024 — before Ink 6.0.0 (May 2025) and React 19. Both declare peers `ink: '>=5'` / `react: '>=18'`, which `ink@6.6.0` + `react@^19` satisfies — `pnpm install` produces zero warnings. The real risk is runtime: these packages were built against Ink 5 / React 18 internals and may crash at runtime with React-19 reconciler mismatches (cf. Ink issue #688). **Phase-0 gate:** a minimal `<TextInput/>` + `<SelectInput/>` render in a smoke test. If they pass, use them. If not, build the input/select components directly (~50 lines each). Same smoke test for `ink-spinner@^5` and `terminal-link@^5` — add them only if needed; Phase 1's 7 components don't obviously require either.

---

## Theme: Tokyo Night Moon

Color tokens defined in `src/adapters/cli/tui/theme.ts`:

| Token | Hex | Usage |
|-------|-----|-------|
| `bg` | `#222436` | Terminal background (via Ink's background color) |
| `bgHighlight` | `#2f334d` | Selected items, code block backgrounds |
| `fg` | `#c8d3f5` | Primary text |
| `fgDim` | `#828bb8` | Dimmed text, descriptions, timestamps |
| `fgGutter` | `#3b4261` | Borders, separators, line numbers |
| `blue` | `#82aaff` | Assistant messages, links, info |
| `cyan` | `#86e1fc` | Timestamps, status indicators |
| `green` | `#c3e88d` | Success glyphs, user messages, tool completion |
| `yellow` | `#ffc777` | Warnings, thinking blocks, in-progress status |
| `red` | `#ff757f` | Errors, tool failures, denied permissions |
| `purple` | `#c099ff` | Skills, model names, gateway labels |
| `orange` | `#ff966c` | Todo items, attention markers |

Mapped to Ink's `color` and `backgroundColor` props on `<Text>` and `<Box>` components. Used as a React context via `useTheme()` hook.

---

## Feature Gap Analysis

### P0 (Must Have — Blockers to Parity)

#### 1. Ink/React TUI Shell
**Current:** `readline.question()` + `console.log()` — sequential output.
**Target:** Full-screen Ink app with `<Box flexDirection="column">` layout. Alternate screen buffer via Ink's `render()`. Component tree: footer (bottom), prompt (bottom-fixed), message area (scrollable flex-grow).

#### 2. Streaming Response Display
**Current:** Agent loop blocks on complete LLM response, renders text and tool steps via `onStep` callback with chalk output. Step-level streaming already exists — the loop emits `StepResult` events and the current CLI prints them live. The gap is **presentation** (Ink component rendering vs. `console.log`) and **token-level** streaming (per-token deltas vs. complete response blocks).

**Phase 1 target:** Ink-based presentation. Each model response and each tool execution renders as a React component as it happens via `onStep` → React state update. No engine changes needed — the loop's existing `onStep` callback is sufficient.

**Phase 2 target:** Token-level streaming. Individual tokens stream into the assistant message text in real-time, with incremental markdown rendering. Requires `provider.chatStream()` on both provider classes.

**Streaming data flow — reuses runAgentLoop, mirrors the SDK's proven pattern:**

```
TUI calls Agent.chatStream(input, signal)
  → runAgentLoop({ onStep: (step) => stream.enqueueStep(step), ... })  ← SAME ENGINE
    → provider.chat()          (each model response is a step)
    → tool execution loop      (each tool call/result is a step)
    → permission checks        (same gate as headless)
    → skill provider switching (same providerFactory)
    → gateway injection        (same middleware/finalHandler)
    → StreamManager            (step events → textStream + stepsStream)
  → TUI use-agent.ts hook      (consumes step streams, renders components)
```

This follows the pattern of `src/adapters/sdk/agent.ts::chatStream()`, which wraps `runAgentLoop` in a background loop, pipes `onStep` events into a `StreamManager`, and exposes `textStream` + `stepsStream`. The CLI Agent adopts the same pattern in Phase 2 — wiring differs (Agent instance state vs. SDK closure variables, plus TUI-wired `approveTool`; `@path` resolution stays at the caller), but the engine path is identical. `StreamManager` was built for exactly this (its docstring: "Eliminate duplication between SDK's streamText() and agent's chatStream()"). Phase 1 needs none of it — it renders via `Agent.chat({ onStep })`; even in Phase 2 the in-process TUI may consume deltas through a direct callback rather than `StreamManager`.

**Token-level streaming (phase 2):** This becomes an additive enhancement to `runAgentLoop`. When `provider.chatStream()` is available, `executeLoop()` branches on the one call site (`response = await currentProvider.chat(...)`) to iterate deltas and emit per-token updates via a new `text_delta` step type. ~40-60 lines in the loop, including a `StreamingResponseAccumulator` to reconstruct incremental `tool_calls[].function.arguments` from fragmented provider streams. The new `text_delta` step type ripples into `StreamManager.toSSEStream`, SDK `chatStream`, and Server event typing — each needs a small addition to handle the new event.

**What changes, what doesn't:**

| Layer | Change | Size |
|-------|--------|------|
| `src/adapters/cli/agent.ts` | **Phase 2:** new `chatStream()` — wraps `runAgentLoop` and exposes deltas to the TUI (~80-100 lines; `@path` resolution already consolidated to the caller in Phase 1; the in-process TUI likely uses a direct `onStep`/`onDelta` callback rather than `StreamManager`) | ~80-100 lines (Phase 2) |
| `src/core/agent-loop.ts` | Phase 2: optionally emit `text_delta` steps when `provider.chatStream()` is used | ~50 lines |
| `src/providers/types.ts` | Add `chatStream()` to `LLMProvider` interface (phase 2) | ~15 lines |
| `src/providers/openai.ts` | Implement `chatStream()` for OpenAI + OpenAI-compatible (phase 2) | ~80 lines |
| `src/providers/anthropic.ts` | Implement `chatStream()` for Anthropic + GLM (phase 2) | ~80 lines |
| `src/core/stream-manager.ts` | Add `text_delta` event handling in `toSSEStream()` (phase 2) | ~10 lines |
| `src/adapters/sdk/agent.ts` | Handle `text_delta` in `chatStream` `onStep` (phase 2) | ~5 lines |
| `src/adapters/server/` | Handle `text_delta` in Server event typing (phase 2) | ~5 lines |

**Untouched (no engine divergence):** `src/core/skill-invoker.ts`, `src/core/tool-executor.ts`, `src/core/permission.ts` — all unchanged.

**Why this is the only correct approach:**

`runAgentLoop` is not a "provider call helper" — it IS the agent. It owns: multi-turn tool execution, the permission pre-filter (`checkToolPermission`), adapter tool approval (`approveTool`/`autoConfirm`), per-skill model switching (`providerFactory`), gateway injected-tool resolution (`config.injectedTools`), and all hook firing sites (`beforeToolCall`, `afterToolCall`, `onStep`, `onError`). Bypassing it means either silently losing all of these in interactive mode or reimplementing hundreds of lines with behavioral divergence. `ARCHITECTURE.md`'s first design decision: "Single runAgentLoop implementation — All adapters share one execution engine — no behavioral divergence." (Note: `onFinish` is declared in `hooks.ts` but never fired by `runAgentLoop`. It is fired by the SDK's `generateText()` wrapper at `src/adapters/sdk/index.ts:186`. Not a loss if the loop is bypassed, but the loop is the correct path regardless.)

#### 3. Slash Command Autocomplete
**Current:** No TAB completion. Discovery via `/help`.
**Target:** Type `/` in prompt → dropdown above input showing fuzzy-filtered commands with descriptions. Uses Ink's `useInput` hook. Sources: the built-in command registry + skill names (a `.seepient/commands/` custom-command loader is added only if that mechanism is introduced).

#### 4. @mention / File Autocomplete
**Current:** Regex substitution in raw input. No discovery.
**Target:** Type `@` → fuzzy file search dropdown. Uses `fs.readdir` / glob for project files. Context-aware: `@alias/` filters within reference root. Multiple mentions per prompt.

#### 5. Tool Execution Display
**Current:** `Executing tool: execute_shell_command...` in gray. No output. No expand/collapse.
**Target:** Bordered `<ToolCallBlock>` with: tool name + args header, live stdout streaming for shell, expandable/collapsible output (default: collapsed, `Ctrl+O` expands all), status glyphs (✓ ✗ ⏳), duration badge.

#### 6. Todo/Task List UI
**Current:** No task tracking visible.
**Target:** `<GoalStatus>` entries in feed. Agent-driven via `manage_todos` tool. Pending/done status with glyphs (⬜ ⏳ ✅ ❌). Persists across turns.

#### 7. Permission & Tool Approval
**Current:** inquirer confirm prompt that suspends ESC detection.
**Target:** `<PermissionPrompt>` rendered inline in feed. Shows tool name, args, risk level. Keyboard y/n/a. No stdin mode switching — stays within Ink's input handling.

---

### P1 (Should Have — Major UX Improvements)

#### 8. Command Palette (Ctrl+P)
Searchable overlay with fuzzy command matching. Renders as Ink overlay (modal `<Box>` positioned with flexbox).

#### 9. Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `Ctrl+P` | Command palette |
| `Ctrl+L` | Clear screen / new conversation |
| `Ctrl+O` | Expand/collapse all tool outputs |
| `Ctrl+M` | Model selector |
| `Ctrl+E` | Open prompt in $EDITOR |
| `Ctrl+C` | Abort agent / clear input (when idle) |
| `PageUp/Down` | Scroll message history |
| `Arrow Up` | Previous command in history |

Uses Ink's `useInput` hook. Global keybindings registered in `use-keybindings.ts`.

#### 10. Footer Status Bar
```
anthropic | sonnet-4 | 12.4k tok | $0.18 | moderate | 3 skills | gw: on
```
Rendered as fixed `<Box>` at bottom. Live token/cost counters. Uses `use-agent` hook for state.

#### 11. Message History with Scrollback
Ink's `Static` component renders immutable history efficiently. Live streaming items use stateful components. `PageUp/PageDown` navigate via scroll offset state.

#### 12. Session Management UI
Session selector overlay with: flat session list, fuzzy search, preview, delete/rename/export.

#### 13. Theme System
Tokyo Night Moon as default. `theme.ts` exports color tokens. Switchable by reloading theme object. No live theme switching in P1 (config file, restart to apply).

---

### P2 (Nice to Have — Differentiators)

14. **Diff Viewer** — Inline diff display for file edits.
15. **Markdown Rendering** — `marked` + `marked-terminal` for ANSI-styled CommonMark.
16. **Thinking Block** — Collapsible reasoning display. Toggle via `/thinking`.
17. **File Watcher** — Footer notification on external file changes.
18. **Live Token Counter** — Real-time in footer during streaming.
19. **Multi-line Editor** — `ink-text-input` for single-line; multiline via `\n` + soft wrap.
20. **Extension Widget System** — `setWidget()` API for extension UI injection.

---

## Implementation Phases

### Phase 0: Pre-flight Gates

Before any Phase 1 code:

1. Add `"jsx": "react-jsx"` to `tsconfig.json` (1 line). Run `pnpm test` — all pre-existing tests must pass (snapshot: 243 across 19 files; the count drifts, so treat as "all pre-existing"). If any test fails due to JSX resolution, fix before proceeding.
2. Run the Ink companion smoke test: a minimal script that `render(<TextInput/>)` and `render(<SelectInput/>)` against `ink@6.6.0` + `react@^19.1.7`. If they crash at runtime, build custom input/select components (~50 lines each) and drop the packages. Do the same for `ink-spinner` and `terminal-link` — if not needed for Phase 1's 7 components, defer.
3. Remove `marked@^18.0.5` from `dependencies` if unused (grep confirms no import in `src/` — dead weight). Re-add later when markdown rendering lands (Phase 3).
4. Run `pnpm install` with zero peer warnings.

### Phase 1: Foundation

1. `pnpm add ink react` + any companion packages that passed the Phase 0 smoke test
2. Extract `runChat()`'s setup phase (config loading, provider resolution, skills init, gateway init, permissions) into a shared `bootstrapCliSession()` function. Both `runChat` (readline) and `startTui` call it. This prevents duplicating ~175 lines of setup between the two dispatch paths.
3. Create `src/adapters/cli/tui/` directory with app root, 7 components, 2 hooks, and lazy-load entry in `index.ts`
4. Wire `render()` call with basic layout: `<MessageArea>` + `<PromptArea>`
5. Connect user input → `Agent.chat({ onStep, approveTool, signal })` → render response in message area. **No new engine API:** the loop's existing `onStep` callback drives step-at-a-time rendering (see §Feature Gap #2). `@path` resolution is consolidated to the caller here.
6. TUI consumes `onStep`: text steps render as `AssistantMessage`, tool steps render as `ToolCallBlock`; `approveTool` is bridged to the inline `<PermissionPrompt>` via a `PromiseWithResolvers`.
7. **Verify:** Compile succeeds. `seepient -n` / `--docker` still use readline. `seepient` (interactive) shows the Ink TUI with input → response flow **including tool execution**: a shell-command prompt renders the tool block with output, a custom-model skill switches providers and runs, a `--moderate` destructive tool prompts for approval inline. `pnpm dev` (tsx) resolves the lazy `.tsx` import. `pnpm test` passes.

**`approveTool` async bridge spec.** In TUI mode, the `approveTool` callback runs inside a detached `runAgentLoop` promise; it must pause and wait for the user to press y/n in a React component. Pattern: `use-agent.ts` creates a `PromiseWithResolvers<boolean>`, sets React state to render `<PermissionPrompt>`, and the pending promise is passed as the `approveTool` to `runAgentLoop`. `<PermissionPrompt>` calls `resolve(true/false)` on keypress. The **caller** (`use-agent.ts`) owns this bridge — it creates the promise and GCs stale resolvers on abort — regardless of whether the underlying call is `Agent.chat()` (Phase 1) or `Agent.chatStream()` (Phase 2).

**`@path` resolution consolidation.** `@path` references are currently resolved twice: once in `repl.ts:497` and again in `agent.chat()` at `agent.ts:79-80`. During Phase 1, consolidate to one call site (the caller — `repl.ts` or `use-agent.ts`) and remove from `Agent.chat()` (and, when it lands in Phase 2, `Agent.chatStream()`). The resolver is idempotent so double-resolution is harmless today, but adding a third call site in the TUI makes this messier.

### Phase 2: Core Interaction
1. Slash command autocomplete in prompt
2. @mention file autocomplete in prompt
3. Tool call block component with expand/collapse
4. **Token-level streaming (additive):** add `provider.chatStream()` to both provider classes; add the `text_delta` step + `StreamingResponseAccumulator` to `runAgentLoop`; add `Agent.chatStream()` on the CLI Agent (exposes deltas to the TUI). Providers without `chatStream()` fall back to `chat()` — headless/SDK/Server unaffected.
5. **Verify:** Type `/hel` → autocomplete shows `/help`. Type `@src/` → file list. Tool calls render as bordered blocks. A streaming provider shows per-token updates; a non-streaming provider falls back with no regression.

### Phase 3: Quality of Life
13. Command palette (Ctrl+P)
14. Keyboard shortcuts via `useInput`
15. Footer status bar with live tokens
16. Theme token application across all components
17. Markdown rendering for all message content
18. **Verify:** Ctrl+P opens palette. Footer updates during streaming. Themes apply correctly.

### Phase 4: Advanced
19. Todo list + `manage_todos` tool
20. Session management UI
21. Diff viewer
22. Thinking block display
23. File watcher integration

---

## Risks & Dependencies

1. **Streaming API (Phase 2 — cross-cutting core change, ~330 lines across 8 files in 3 layers).** Add `provider.chatStream()` to the two provider classes (`OpenAIProvider`, `AnthropicProvider`). `OpenAIProvider` = OpenAI + OpenAI-compatible (shared class). `AnthropicProvider` = Anthropic + GLM (shared class). ~80 lines each using their SDKs' native streaming. Agent loop gains ~50 lines for delta iteration + `StreamingResponseAccumulator` (reconstructs incremental tool-call argument fragments). The CLI `Agent.chatStream()` (~80-100 lines) also lands here — Phase 1 renders via the existing `Agent.chat({ onStep })` path, so no Agent or engine API is added in Phase 1. `StreamManager`, SDK, and Server each need ~5-10 lines for the new `text_delta` step type. This is not a small additive enhancement — it touches Core, Infrastructure, and all three adapters. Needs its own mini-PRD before Phase 2 start.

2. **React in CLI bundle** — Adds ~500KB to install size (React + Ink + utilities). Mitigation: lazy import only in interactive mode. Headless never loads it. Acceptable for a developer tool.

3. **Ink 6.6.0 stability** — Ink 6.6.0 (May 2025) targets React 19 (Dec 2024). Both are stable, mature libraries. Assumption: React 19 + Ink 6.6.0 are production-ready for CLI use. Fallback: Ink 5 + React 18 if stability issues arise. If Ink becomes unmaintained, the component API is standard React — porting to another renderer is straightforward.

4. **Full Ink bet vs. enhanced readline** — A 90/10 alternative exists: keep readline + add Ink-rendered tool blocks only (no full alternate-screen app, no Static feed, no overlays). This would deliver tool visibility and streaming with ~4 fewer components and no stdin-ownership seam. The PRD bets the full Ink app is worth the surface because: (a) the component model compound-benefits (autocomplete, palette, session browser, keybindings all become additive components, not one-off hacks), (b) the existing Command Code reference proves the approach, and (c) the lazy-load architecture keeps headless mode unaffected regardless. Explicit decision: proceed with full Ink, but if Phase 1 drags, fall back to the 90/10 path (enhanced readline + Ink tool blocks) to ship value sooner.

4. **Terminal compatibility** — Ink renders using ANSI escape sequences. Works in all modern terminals (iTerm2, Terminal.app, Windows Terminal, VS Code terminal, tmux). Docker containers with `-it` flag work. CI/headless never loads the TUI.

5. **Seepient architecture constraints** — Phase 1 is contained to the CLI adapter; the TUI drives the existing `agent.chat({ onStep })` path, never reaches into provider or core internals. The existing `agent.chat()` path is also used by headless mode. Phase 2 is an additive, backward-compatible enhancement to the shared engine (new optional `provider.chatStream()` + `Agent.chatStream()` + `text_delta` step type, plus provider implementations), consistent with the single-`runAgentLoop` invariant rather than a bypass.

6. **Build configuration** — Requires `"jsx": "react-jsx"` in `tsconfig.json` (1 line). `tsc` supports JSX compilation natively since TypeScript 4.1. No bundler needed — same `tsc` build as today. React is kept out of headless because `index.ts` uses a dynamic `import('./tui/index.js')` guarded by `resolveLaunchMode(options) === 'interactive'` (composes TTY + `--no-interactive` + piped stdin + `--docker` + `SEEPIENT_NO_INTERACTIVE` — the same predicate that selects the system prompt). No static import chain from `index.ts` or `repl.ts` reaches any `.tsx` file. Guard: CI should assert `grep -L jsx-runtime dist/adapters/cli/repl.js` (fails if React leaks into headless) — enforced from the first TUI commit, not deferred. **Dev-mode caveat:** under `pnpm dev` (tsx) the lazy `.js` specifier must resolve the `.tsx` source; verify on the first US1 commit or the interactive dev loop breaks.

---

## Success Metrics

- Slash command discovery: "type `/` and see options" (no `/help` needed)
- Tool execution visibility: "live streaming output in bordered blocks" (vs current "gray text, no output")
- Input efficiency: "@fuzzy-path-completion" (vs "type full paths from memory")
- Task tracking: "live todo list with status glyphs" (vs "no visibility")
- Perceived responsiveness: "real-time token streaming + markdown" (vs "spinner then text dump")
- Platform consistency: "identical experience on macOS, Linux, Docker, Windows" (vs "macOS-only native addon")
