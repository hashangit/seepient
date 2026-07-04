# Implementation Plan: TUI Upgrade (Ink/React)

**Branch**: `001-tui-upgrade` | **Date**: 2026-06-13 | **Spec**: [spec.md](./spec.md)

**Source**: `docs/tui-upgrade-prd.md` (authoritative PRD; this plan extracts tech
stack + structure for task generation).

## Summary

Replace the readline + chalk + inquirer interactive CLI with a full-screen
Ink/React TUI that streams agent responses, renders tool execution as live
bordered blocks, and offers inline permission approval. Headless / piped /
`--no-interactive` / `--docker` modes are byte-identical to today — the TUI is
lazy-loaded only when `resolveLaunchMode(options) === 'interactive'` (the shipped
`resolveLaunchMode()` composes TTY + `--no-interactive` + piped stdin + `--docker`
+ `SEEPIENT_NO_INTERACTIVE`). US1 wires the existing `Agent.chat({ onStep })` path
(no new engine API — PRD line 275). Token-level streaming (`provider.chatStream()`
+ `text_delta` step, plus the deferred `Agent.chatStream()`) is Phase 2 and remains
an additive, backward-compatible enhancement to the shared `runAgentLoop`.

## Technical Context

**Language/Version**: TypeScript (target ES2024, module NodeNext, `strict: true`).
JSX via `"jsx": "react-jsx"` (one tsconfig line). No bundler — `tsc` compiles
`.tsx` natively.

**Primary Dependencies**: `ink@6.6.0`, `react@^19.1.7`, plus companions that pass
the Phase 0 smoke test (`ink-spinner`, `ink-select-input`, `ink-text-input`,
`terminal-link` — add only if a render smoke test passes against Ink 6 / React 19;
otherwise build the ~50-line equivalents). `marked@^18` removed as dead weight.

**Storage**: N/A (in-memory TUI; session persistence already exists via
`PersistenceBackend`).

**Testing**: Vitest (existing suite — snapshot 243 tests across 19 files; treat
as "all pre-existing tests"). TUI components tested with Ink's `render()` testing
helpers where feasible; manual smoke tests per phase (the PRD defines explicit
"Verify:" gates).

**Target Platform**: Any modern TTY terminal (macOS, Linux, Docker `-it`, Windows
Terminal, VS Code, tmux). CI/headless/Docker non-interactive never load React.

**Project Type**: CLI TUI — additive subdirectory under the CLI adapter layer.

**Performance Goals**: No perceivable input latency; tool stdout streams live into
the bordered block; streaming items update per token in Phase 2.

**Constraints**:
- **Single `runAgentLoop` invariant** — the TUI MUST drive the shared engine via
  `Agent.chat({ onStep, approveTool, signal })` (US1) and `Agent.chatStream()`
  (US2, token deltas). No bypass, no parallel loop. US1 needs no new engine API —
  the loop's existing `onStep` is sufficient (PRD line 275).
- **Launch-mode single source of truth** — TUI dispatch reuses the shipped
  `resolveLaunchMode()` (the same predicate that selects the system prompt), NOT a
  separate `isTTY && interactive` check, so `--docker` / `SEEPIENT_NO_INTERACTIVE` /
  piped stdin never mis-launch the TUI.
- **Lazy load** — React/Ink enter memory ONLY in interactive mode via a dynamic
  `import('./tui/index.js')` in `index.ts`, guarded by
  `resolveLaunchMode(options) === 'interactive'`. No static import chain from
  `index.ts` or `repl.ts` reaches a `.tsx`. CI asserts React stays out of headless
  (enforced from the first TUI commit, not deferred to Polish).
- **Dev-mode module resolution** — under `pnpm dev` (tsx) the lazy import
  specifier `./tui/index.js` must resolve the `.tsx` source; verified in US1 (the
  primary interactive dev loop depends on it).
- **No bundler** — `tsc` only. `pnpm` only (never npm).
- **Headless parity** — headless/SDK/Server paths and system prompts unchanged.
- **stdin ownership** — in TUI mode `setupInterrupt()` is NOT called; Ink owns
  raw stdin and maps ESC/Ctrl+C → `agent.abort()`.

**Scale/Scope**: ~15 components + 4 overlays + 4 hooks + theme + lazy entry. Phase
1 ships 7 components + 2 hooks. Token streaming (Phase 2, now including the deferred `Agent.chatStream()`) ≈ 330 lines across 8 files in 3 layers, needs its own mini-PRD.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| I. Single Execution Engine & Layered Boundaries | ✅ Compliant | TUI is CLI-adapter-only; drives `Agent.chat({onStep})` (US1) / `Agent.chatStream()` (US2) → `runAgentLoop`. No engine bypass. Provider/core internals untouched in Phase 1. |
| II. Single Source of Truth | ✅ Compliant | `@path` resolution consolidated to one call site (caller). TUI dispatch reuses the shipped `resolveLaunchMode()` (one launch-mode predicate, shared with system-prompt selection). StreamManager reused by SDK/Server; the in-process TUI consumes `onStep`/deltas directly — no engine fork. |
| III. Simplicity First | ✅ Compliant | Theme starts as inline hex (no hook). Companions only added if smoke test passes. `marked` removed. US1 wires the existing `Agent.chat({onStep})` path instead of pre-building `chatStream()` (PRD line 275: onStep suffices) — `chatStream()` deferred to US2. |
| IV. Surgical Changes | ✅ Compliant | `repl.ts`/headless paths untouched. `setupInterrupt()` stays for readline fallback. |
| V. Safe by Default & Verifiable | ✅ Compliant | Every phase has an explicit “Verify:” gate. Non-interactive `seepient -n` must keep working. The pre-existing test suite (snapshot 243) must pass after the tsconfig change. |

## Project Structure

```text
specs/001-tui-upgrade/
├── plan.md              # This file
├── spec.md              # User stories (US1-US4)
└── tasks.md             # /speckit.tasks output

src/adapters/cli/
├── index.ts             # + TUI/REPL dispatch (dynamic import)
├── repl.ts              # unchanged (readline fallback)
├── agent.ts             # + chatStream() method (US2; US1 uses existing chat({onStep}))
├── bootstrap.ts         # NEW — extracted shared session setup
├── system-prompts.ts    # shipped — no change
└── tui/                 # NEW — lazy-loaded
    ├── app.tsx          # TuiApp root
    ├── index.ts         # renderApp/startTui entry
    ├── theme.ts         # Tokyo Night Moon tokens
    ├── components/      # message-area, user-message, assistant-message,
    │                    # tool-call-block, prompt-area, permission-prompt,
    │                    # error-message, (+ P2: info-message, bash-output,
    │                    # footer, autocomplete)
    ├── overlays/        # (P3: command-palette, model-selector, help-dialog)
    │                    # (P4: session-selector)
    └── hooks/           # use-agent, use-feed (+ P3: use-keybindings, use-theme)
```

**Structure Decision**: Single-project layout. All new code under
`src/adapters/cli/tui/`. Phase 1 edits two existing files (`index.ts`,
`tsconfig.json`) plus one extraction (`bootstrap.ts` from `repl.ts`);
`agent.ts` gains `chatStream()` in US2. Everything else is new files.

## Complexity Tracking

> No constitution violations requiring justification. The full-Ink bet (vs the
> 90/10 enhanced-readline alternative) is a documented product decision in the
> PRD ("Risks & Dependencies" §4), not a complexity violation.
