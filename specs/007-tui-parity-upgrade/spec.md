# Feature Specification: TUI Parity & Generative Widget Upgrade

**Feature Branch**: `007-tui-parity-upgrade`
**Created**: 2026-07-04
**Status**: Planned
**Predecessors**: `001-tui-upgrade` (Ink/React TUI), `003-tui-input-and-logo` (input box + logo), `006-inline-diff-viewer` (safe write + diff — the metadata-passthrough precedent this builds on)
**Supersedes**: none. **Reaffirms**: `005-fullscreen-tui` is **stays reverted** — the `<Static>` + native-scrollback model is retained; this spec does not reintroduce alt-buffer or mouse capture.

**Source**: Comparative evaluation of `can1357/oh-my-pi` (omp) — a Pi-agent derivative whose TUI polish exceeds Seepient's. Source for every claim below is grounded in the omp repository at `/tmp/omp-eval` (cloned during research) and Seepient's own source.

## Motivation

Seepient's TUI is functional but visibly behind omp in three measurable ways:

1. **Streaming flicker.** `use-agent.ts` calls `setStreamingText()` on every `text_delta` step — at 50–100 tok/s this drives 50–100 React renders/sec, and Ink's line-diff renderer (no CSI 2026 synchronized output) paints partial frames. omp's `pi-tui` uses synchronized output + differential rendering for zero-flicker streaming.
2. **No generative interactive UI.** Responses are walls of text. The user wants the agent to compose interactive widgets (tables, product cards, forms) whose actions round-trip back as new turns — "advanced generative UI within the TUI." omp's `ExtensionUIContext` (`setWidget`, `custom()`) already proves this architecture in code; Seepient has nothing equivalent.
3. **Whole-file edits.** `write_file` sends entire file contents; omp's `hashline` emits hash-anchored line patches. omp reports large token savings and first-attempt landing-rate improvements. This is the single highest-leverage gap.

## Scope Decisions (confirmed)

| Decision | Choice | Rationale |
|---|---|---|
| Rendering model | **Retain Ink + `<Static>` + native scrollback** (005 stays reverted) | 005's alt-buffer caused mouse-capture gibberish and lost native scrollback. The `ink-reset.ts` `<Static>`-remount model stays. Track 2 improves *within* Ink (throttle, memo, cursor hide) — no alt-buffer return. |
| Generative UI execution model | **L1 declarative palette only.** LLM emits `{kind, props, actions}`; **no model-emitted executable code** (L3 is a non-goal) | Behavior lives in the agent loop, not the widget. Safety + the model is bad at behavior code anyway. |
| Widget action dispatch | **Round-trip through the agent loop** as a new user turn (`widget_action` synthetic message) | Mirrors Slack Block Kit / Adaptive Cards. Model never executes; harness mediates. |
| Hashline adoption | **Phase 4, independent of renderer decision** | hashline is a tool + tool-handler change; the diff viewer (006) already exists. Highest leverage, no architecture dependency. |
| Full omp depth parity (LSP, DAP, subagents, hindsight, inline images) | **Deferred / non-goal for this spec** | Seepient is a framework (SDK + Server + gateway + comms); cloning omp's 63k-line terminal-only surface would sacrifice breadth. Inline images gated by renderer decision (deferred). |
| Custom differential renderer (omp `pi-tui` port) | **Deferred.** Evaluated in research; not adopted now. | Cost (~4k-line engine port) not justified until L1 widgets + throttle prove insufficient. Re-evaluate after Phase 1–3 ship. |
| Interactive widgets scope | **Keyboard-first; mouse optional** via `?1006h` SGR mouse mode in overlays only (matches existing overlay behavior). No alt-screen. | 005 lesson: mouse capture in the live region causes gibberish. |

## What This Spec Does NOT Do

- Does **not** reintroduce alt-screen / alternate-buffer (005 lesson).
- Does **not** add a custom differential renderer or CSI 2026 in this spec (deferred to a future spec after Phase 1–3 evaluation).
- Does **not** execute model-emitted widget code (L3 non-goal).
- Does **not** add inline images, LSP, DAP, subagents, or hindsight memory (future specs).
- Does **not** change the agent engine, providers, SDK, or Server. Headless paths byte-identical.

## Tracks (summary — see plan.md for phasing)

| Track | Summary | Risk |
|---|---|---|
| **T0** — Quick wins | 30fps throttle, cursor hide, `React.memo`, `ink-reset` audit | low |
| **T1** — Generative widgets | `render_widget` tool, L1 palette, `ChatBlock` lifecycle, `widget_action` round-trip | medium (new contracts) |
| **T2** — Rendering & editor foundation | Rich markdown, streaming commit gating, multiline editor (Ink-bounded), zero-flicker-via-throttle | medium |
| **T3** — Edit system (hashline) | Hash-anchored line patches, `SnapshotStore`, streaming diff stabilization | medium (tool contract change) |
| **T4** — Component parity | `ChatBlock`, widget host controller, thinking indicator, `TabBar`, plan-review-overlay, etc. | low–medium |

## User Scenarios & Testing

### US-T0 — Smooth streaming (P1, MVP)
As a user watching a long streamed response, I perceive no flicker.
**Acceptance**: at 100 tok/s sustained, React renders ≤30/sec (transient spikes on commit/abort allowed); cursor hidden while running; frozen history not re-rendered. Measured via render-count probe.

### US-T1-1 — Agent composes a widget (P1)
As a user, the agent responds with a product card grid instead of a wall of text.
**Acceptance**: `render_widget({kind:"product_card", …})` renders a bordered skeleton frame with title + rendered content; invalid `kind` rejected before reaching TUI.

### US-T1-2 — Widget action round-trips (P1)
As a user, I press Enter on a widget's "Buy" action and the agent continues.
**Acceptance**: action produces a visible new agent turn (`widget_action` synthetic message), not a console log. Agent sees `widgetId`, `actionId`, current `state`.

### US-T3 — Hash-anchored edit (P1)
As a user, the agent edits a 500-line file by emitting a 6-line patch, not 500 lines.
**Acceptance**: model emits `[path#tag] SWAP A.=B: +…`; hash mismatch → reject with stale-anchor error; successful apply renders in existing `DiffViewer`.

### US-T4-1 — Lifecycle-aware transcript block (P1)
As a user, a live widget animates while active and freezes cleanly into scrollback on completion without ghosting.
**Acceptance**: `ChatBlock.isFinalized()` controls live-vs-frozen; `finish()`/`dispose()` run cleanups exactly once; `<Static>` remount on resume repaints blocks without duplicates.

## Operational Constraints

- **Backward compatibility**: every existing tool keeps working (006 contract row 1–2 preserved). `write_file` whole-file mode retained as hashline fallback.
- **No new runtime deps for T0/T4**: throttle + memo + cursor hide use only stdlib + existing Ink.
- **Test suite**: Vitest, matching existing `__tests__/` pattern. New components ship with tests (003/006 precedent).
- **Constitution**: `.specify/memory/constitution.md` is the unfilled template (no hard gates). This spec follows AGENTS.md conventions (simplicity first, surgical changes, goal-driven execution).

## Out-of-Scope Variants Considered

| Variant | Rejected because |
|---|---|
| Port omp `pi-tui` wholesale (~4k-line engine) | Cost not justified until L1 widgets prove insufficient; 005's mouse-capture lesson makes alt-buffer risky |
| L3 model-emitted executable widgets | Sandbox hell; model is bad at behavior code; L1 covers 90% of value |
| Carbonyl-style embedded Chromium | Maximalist, lightly maintained, not reproducible |
| omp `modes/` 63k-line surface clone | Sacrifices Seepient's framework breadth (SDK/Server/gateway/comms) |
