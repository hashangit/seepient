# Implementation Plan: TUI Persistent Input Box + Seepient Agent Logo

**Branch**: `003-tui-input-and-logo` (currently on `feature/tui-upgrade-prd`)
| **Date**: 2026-06-15 (revised post-scrutinize) | **Spec**: [spec.md](./spec.md)

**Input**: `/specs/003-tui-input-and-logo/spec.md`. Builds on the shipped
`001-tui-upgrade` Ink/React TUI.

**Depends on**: `specs/005-fullscreen-tui` — **build 005 first**. 005's full-screen
model gives the input box its viewport-bottom pinning; 003's `InputBox` drops into
005's pinned bottom region and the logo is the first windowed feed entry (no layout
changes here). 003 also works standalone on the current content-flow model, minus
pinning.

## Summary

Two pure-presentation additions in the CLI adapter layer:

1. **A persistent, bordered input box** — the borderless `PromptArea` (which
   vanishes while the agent runs) is wrapped in a rounded box (`╭╮╰╯`) rendered on
   **every** frame as the last live element, directly above the footer. It is
   **disabled** (dimmed, inert) whenever the agent is running **or** an overlay is
   open **or** a permission prompt is pending; the spinner sits **above** the box.
   Fixes the "not clearly visible / vanishes" complaint and preserves the
   overlays' exclusive-stdin contract.
2. **A Seepient Agent logo** — a large Tokyo Night rainbow gradient banner
   (`red→…→purple`, 45° axis, **HSL** hue rotation) shown on launch as a real
   feed entry (`kind: 'logo'`) so it scrolls away as the user chats. Pure
   `rainbow45` over the existing `theme.ts` palette — no new dependency.

Rename is **logo-only** (intentional mixed branding). No engine/core/infra
changes; lazy-load invariant preserved. Persistent wordmark **deferred**.

## Technical Context

**Language/Version**: TypeScript (ES2024 / NodeNext, `strict`, `jsx: react-jsx`).
New files are `.tsx`. No bundler — `tsc` compiles natively.

**Primary Dependencies**: `ink@6.6.0`, `react@^19.1.7` (already present). **No new
dependency** — gradient is ~50 lines of pure code; the border is box-drawing chars.

**Storage**: N/A — pure TUI presentation. No schema, no migration.

**Testing**: Vitest. `rainbow45` gets unit tests (endpoints + a saturation guard
against muddy mid-tones). Components validated via `quickstart.md` manual
scenarios. Full pre-existing suite must stay green.

**Target Platform**: Any modern TTY. Non-interactive paths never load the new code.

**Performance Goals**: No perceivable input latency; the gradient grid computes
**once** (logo is static) and the banner is a single `<Static>` entry → no
per-frame cost.

**Constraints**:
- **Lazy-load invariant** — new `.tsx` loads only via `import('./tui/…')` in
  interactive mode. No static import from headless paths.
- **Single color source** — `theme.ts` is the only palette; gradient samples it.
- **Surgical** — input logic reused; one `enabled` flag added to `TextInput`.
- **Positioning is content-flow, NOT viewport-bottom-pinned.** The TUI uses plain
  Ink (`index.tsx`, no fullscreen). The box is the last live element above the
  footer, but on short sessions it sits at the bottom of the *written content*,
  not the terminal. True viewport-bottom pinning (Claude Code/Codex style) needs
  alternate-screen mode and is **out of scope** (see `spec.md` *Constraints*).
- **No bundler; `pnpm` only.**

**Scale/Scope**: ~4 new files (`logo/gradient.ts`, `logo/grids.ts`,
`components/input-box.tsx`, `components/logo-banner.tsx`) + a unit test; modify
`components/text-input.tsx`, `components/prompt-area.tsx`, `tui/types.ts`,
`components/message-area.tsx`, and `app.tsx`. Each file well under the 400-line
budget.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| I. Single Execution Engine & Layered Boundaries | ✅ Compliant | Presentation-only under `src/adapters/cli/tui/`; imports only `theme.ts` + core types. Input still drives the same `Agent` path; no engine change. |
| II. Single Source of Truth | ✅ Compliant | `theme.ts` is the only palette. `app.tsx` remains the single owner of `input`/`isRunning`/`overlay`/`pendingPermission`; `InputBox.disabled` is *composed* from them, not duplicated. `FeedEntry` (one owner: `tui/types.ts`) gains the logo variant. |
| III. Simplicity First | ✅ Compliant | No new dependency. No transition state machine (banner scrolls via `<Static>`). Input logic reused. The composite disable (`isRunning‖overlay‖permission`) is one boolean expression, not a state machine. Wordmark deferred rather than force-fit. |
| IV. Surgical Changes | ✅ Compliant | `text-input.tsx` +1 optional prop; `prompt-area.tsx` forwards it; `types.ts`/`message-area.tsx` add one union variant + one switch case; `app.tsx` reorders the live region and seeds one feed entry. Headless/SDK/Server/`repl.ts` untouched. |
| V. Safe by Default & Verifiable | ✅ Compliant | Every `quickstart.md` scenario is a Verify gate. `pnpm test` baseline holds; gradient fn unit-tested (with a saturation guard). Non-interactive `seepient -n`/piped/`--docker` stay byte-identical. |

*Post-Phase-1 re-check*: compliant — no schema, no new state owner, no boundary
handler, no long-running work. The scrutinize pass corrected the inaccurate
"bottom-anchored" premise, added overlay/permission to the disable condition,
pinned the logo to a typed feed entry, and switched the gradient to HSL — no
constitution violation remains.

## Project Structure

```text
specs/003-tui-input-and-logo/
├── plan.md              # This file
├── spec.md              # User stories US1-US2 + FRs (post-scrutinize)
├── research.md          # Phase 0 — palette, HSL gradient, positioning model
├── data-model.md        # In-memory shapes (no persistence)
├── contracts/
│   ├── tui-components.md  # InputBox / LogoBanner / app.tsx / TextInput / FeedEntry
│   └── gradient.md        # rainbow45 pure function (HSL)
└── quickstart.md        # Validation scenarios S1-S6
# tasks.md is generated by /speckit.tasks

src/adapters/cli/tui/
├── app.tsx              # MODIFY — live-region restructure + composite disable + seed logo entry
├── types.ts             # MODIFY — add `kind: 'logo'` to FeedEntry
├── theme.ts             # unchanged (single color source)
├── logo/                # NEW
│   ├── gradient.ts      # rainbow45 pure fn — HSL hue rotation (unit-tested)
│   └── grids.ts         # ASCII grid for the banner (constant)
└── components/
    ├── text-input.tsx    # MODIFY — add optional `enabled` prop
    ├── prompt-area.tsx   # MODIFY — forward `enabled` to TextInput
    ├── message-area.tsx  # MODIFY — `FeedItem` case for kind:'logo'
    ├── input-box.tsx     # NEW — rounded border + wraps PromptArea; `disabled`
    └── logo-banner.tsx   # NEW — large gradient banner, rendered via kind:'logo'

src/adapters/cli/tui/logo/gradient.test.ts   # NEW — unit tests
```

**Structure Decision**: Single-project layout. All new code under
`src/adapters/cli/tui/` (presentation layer) with the pure gradient isolated in
`tui/logo/`. Five existing files modified surgically; four new. Nothing crosses
into core/infra/engine or other adapters.

## Complexity Tracking

> No constitution violations. The persistent compact wordmark is **deferred**
> (viewport-top pinning needs a feed-rendering rewrite). True viewport-bottom
> input pinning is likewise out of scope (plain-Ink, no fullscreen) and
> documented as a limitation — not snuck in.

## Done When

- [ ] `research.md`, `data-model.md`, `contracts/`, `quickstart.md` generated ✅
- [ ] Agent context (`CLAUDE.md` SPECKIT markers) updated ✅
- [ ] Scrutinize findings (#1–#5) addressed in the artifacts ✅
- [ ] Completion reported

Next step: `/speckit-tasks` → `tasks.md` → `/speckit-implement`.
