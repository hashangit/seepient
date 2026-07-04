# Implementation Plan: TUI Parity & Generative Widget Upgrade

**Branch**: `007-tui-parity-upgrade` | **Date**: 2026-07-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature spec `specs/007-tui-parity-upgrade/spec.md`. Phase artifacts: [research.md](./research.md), [data-model.md](./data-model.md), [contracts/widget-protocol.md](./contracts/widget-protocol.md), [contracts/hashline-edit.md](./contracts/hashline-edit.md), [contracts/feed-lifecycle.md](./contracts/feed-lifecycle.md), [quickstart.md](./quickstart.md).

**Predecessors**: `001-tui-upgrade` (Ink/React TUI), `003-tui-input-and-logo` (input + logo on `<Static>`), `006-inline-diff-viewer` (safe write + diff — the metadata-passthrough precedent this builds on). **Reaffirms**: `005-fullscreen-tui` stays **reverted** — alt-buffer/mouse-capture model not reintroduced.

## Summary

Bring Seepient's TUI to capability parity with omp (oh-my-pi) without sacrificing the framework's breadth or the proven `<Static>` + native-scrollback model. Five tracks, dependency-ordered: T0 streaming-polish quick wins; T1 generative interactive widgets (the user's vision — LLM composes a declarative widget palette whose actions round-trip as new turns); T2 rendering/editor foundation within Ink's ceiling; T3 hash-anchored edits (the single highest-leverage gap, independent of the renderer decision); T4 component parity (ChatBlock lifecycle, widget host, thinking indicator, and matched inventory items).

**Architectural decision (research.md R1)**: stay on Ink. Drive flicker to "virtually imperceptible" via throttling + memoization + cursor hide. A custom differential renderer (omp `pi-tui` port) is **deferred** — re-evaluate after Phases 1–3 ship. The 005 lesson (alt-buffer + mouse capture = gibberish) governs: no alt-screen, keyboard-first interaction, mouse only inside overlays.

## Technical Context

**Language/Version**: TypeScript 5.x, ES2022, NodeNext modules (`tsconfig.json`). Runtime: Node.js ≥20 (CLI/SDK/Server), Bun-compatible where omp comparisons are drawn.

**Primary Dependencies**:
- **Existing (retained)**: `react`, `ink`, `ink-spinner`, `yoga-layout` (via Ink), `diff` (006), `marked` (existing markdown wrapper), `vitest`.
- **New (this spec)**: none for T0/T4 (stdlib + existing Ink only). T1/T2/T3 add no runtime deps (hand-rolled patcher, schema validators). **No bundler** (`tsc` to ES2022 — `AGENTS.md`).

**Storage**: filesystem (`~/.seepient/` for sessions, settings, gateway) — unchanged. `SnapshotStore` is session-scoped, in-memory, not persisted (matches omp).

**Testing**: Vitest, 322 tests across 33 files (existing). New tests follow the `__tests__/` + ink-testing-library pattern (`tool-call-block.test.tsx`, `feed-serializer.test.ts` precedents). **CI gates publish on test pass** (`AGENTS.md`).

**Target Platform**: macOS / Linux / Windows terminals. TTY for TUI; headless for SDK/Server. Inline-image support (Kitty/iTerm2/Sixel) is **deferred** — not in this spec.

**Project Type**: headless AI agent framework with CLI / SDK / Server adapters. This spec touches CLI (TUI) + Tools + Core (hashline). SDK/Server byte-identical (widgets/hashline are adapter-agnostic at the tool layer).

**Performance Goals**:
- ≤30 React renders/sec at 100 tok/s streaming (QW-1).
- Widget render <50ms (NFR-1).
- Zero-flicker streaming "virtually imperceptible" (NFR-2, Ink-bounded — flicker reduced to the point of not being noticed in normal use via throttle + memo + cursor hide; **hard zero-flicker is not achievable on Ink** and is deferred with the renderer port — see research.md R1).
- `edit_file` payload ≥5× smaller than equivalent whole-file `write_file` for targeted edits (FR-7).

**Constraints**:
- Backward compatibility: every existing tool keeps working. `write_file` retained. 006 contract rows 1–2 preserved.
- No new runtime dependencies for T0/T4.
- Surgical changes (`AGENTS.md` §3): every changed line traces to a requirement.
- `AGENTS.md` §2 simplicity: no L3 executable widgets, no speculative components, no Carbonyl/alt-screen rabbit holes.

**Scale/Scope**: TUI surface today ≈1,500 LOC across 35 files. This spec adds ≈2,500 LOC (hashline ~800, widgets ~900, ChatBlock + T4 ~600, throttle/memo ~200). No file exceeds ~500 LOC (matches existing style).

## Constitution Check

**GATE**: `.specify/memory/constitution.md` is the unfilled template (no hard gates recorded). Gate status: **PASS** (nothing to violate).

In lieu of recorded constitution principles, this plan adheres to `AGENTS.md`:

| AGENTS.md principle | How this plan obeys |
|---|---|
| §1 Think before coding | research.md resolves all unknowns; no `NEEDS CLARIFICATION` remains |
| §2 Simplicity first | L1 declarative widgets only; no L3 execution; renderer port deferred; deferred items explicitly listed |
| §3 Surgical changes | every change traced to a Track item; dead code left untouched unless orphaned by these changes |
| §4 Goal-driven execution | each Track has verifiable success criteria (quickstart.md); tests written before/with implementation (Vitest, 003/006 precedent) |

**Post-design re-check**: the design (data-model.md, contracts/) adds one new feed kind, one new tool, one new core module. No duplication of existing execution systems (single `runAgentLoop` unchanged; single `executeTool` extended per 006 precedent). **PASS**.

## Project Structure

### Documentation (this feature)

```text
specs/007-tui-parity-upgrade/
├── plan.md              # this file
├── spec.md              # feature specification
├── research.md          # Phase 0 — resolves ARCH-1 and all unknowns
├── data-model.md        # Phase 1 — entity definitions
├── contracts/
│   ├── widget-protocol.md       # render_widget → TUI → widget_action round-trip
│   ├── hashline-edit.md         # edit_file tool + SnapshotStore + patcher
│   └── feed-lifecycle.md        # ChatBlock + BlockEntry + useFeed extension
├── quickstart.md        # Phase 1 — per-track validation
└── tasks.md             # Phase 2 — implementation tasks (next command)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── hashline/                    # NEW (T3) — adapter-agnostic patcher
│   │   ├── types.ts                 # HashlinePatch, HashlineOp, errors
│   │   ├── grammar.md               # patch grammar (port of omp)
│   │   ├── parser.ts                # patch string → HashlinePatch
│   │   ├── patcher.ts               # apply + 3-way merge recovery
│   │   ├── snapshot-store.ts        # file-content hash registry
│   │   ├── line-diff-ops.ts         # SWAP/DEL/INS line ops
│   │   └── __tests__/
│   │       ├── parser.test.ts
│   │       ├── patcher.test.ts
│   │       └── snapshot-store.test.ts
│   └── errors.ts                    # EXTEND — HashlineError + WidgetError codes
├── tools/
│   ├── widgets.ts                   # NEW (T1) — render_widget tool + parseWidgetSpec
│   ├── edit-file.ts                 # NEW (T3) — edit_file tool module
│   ├── core.ts                      # EXTEND — read_file/write_file record snapshots
│   └── index.ts                     # EXTEND — register render_widget + edit_file
└── adapters/cli/tui/
    ├── types.ts                     # EXTEND — BlockEntry in FeedEntry union
    ├── chat-block.ts                # NEW (T4-1) — ChatBlockInstance + ChatBlockHost
    ├── widget-host.ts               # NEW (T4-2) — mounts widgets, dispatches actions
    ├── stream-flush.ts              # NEW (T0) — 30fps throttle helper
    ├── stream-commit-gate.ts        # NEW (T2) — isLiveReflowingMarkdown + stripTrailingUnbalancedRemoval
    ├── widgets/                     # NEW (T1) — L1 palette renderers
    │   ├── types.ts                 # WidgetSpec, WidgetAction, dispatch types
    │   ├── widget-block.tsx         # skeleton frame + kind dispatch
    │   ├── table.tsx
    │   ├── keyvalue.tsx
    │   ├── chart.tsx
    │   ├── tree.tsx
    │   ├── panel.tsx
    │   ├── diff.tsx                 # delegates to existing DiffViewer
    │   ├── form.tsx                 # interactive
    │   ├── product-card.tsx         # interactive
    │   └── status-grid.tsx
    ├── components/
    │   ├── assistant-message.tsx    # EXTEND (memo + thinking block mount)
    │   ├── tool-call-block.tsx      # EXTEND (edit_file multi-file rendering)
    │   ├── message-area.tsx         # EXTEND (BlockEntry live/static split)
    │   ├── thinking-indicator.tsx   # NEW (T4-3)
    │   ├── tab-bar.tsx              # NEW (T4-4)
    │   ├── plan-review-overlay.tsx  # NEW (T4-5)
    │   ├── truncated-text.tsx       # NEW (T4-6) — width-aware helper
    │   └── toast.tsx                # NEW (T4-7) — non-feed notify()
    ├── hooks/
    │   ├── use-agent.ts             # EXTEND (throttle, render_widget branch, edit_file branch)
    │   ├── use-feed.ts              # EXTEND (mountBlock/updateBlock/finalizeBlock/disposeBlock)
    │   ├── use-cursor.ts            # NEW (T0) — cursor hide on isRunning
    │   └── use-block-cleanup.ts     # NEW (T4-1) — dispose all live blocks on unmount
    └── __tests__/
        ├── use-agent-throttle.test.ts
        ├── memo.test.tsx
        ├── ink-reset-guard.test.ts
        ├── chat-block.test.ts
        ├── stream-commit-gate.test.ts
        └── widget-block.test.tsx
```

**Structure Decision**: single-project layout (matches existing). New code lives alongside existing patterns — `src/core/hashline/` mirrors existing `src/core/middleware/` subdirectory convention; `widgets/` mirrors existing `overlays/` and `components/` co-location. No new top-level packages (not a monorepo — contrast with omp).

## Complexity Tracking

No constitution violations to justify. One scope boundary worth recording:

| Boundary | Decision | Why |
|---|---|---|
| Custom renderer port (omp `pi-tui`) | **Deferred**, not rejected | Cost (~4k LOC) not justified until T0 throttle + T1 widgets prove insufficient. Re-evaluated after Phase 3. |
| Inline images (Kitty/Sixel) | **Deferred** | Gated by the renderer decision. T1 widgets cover the "not a wall of text" goal without images. |
| LSP / DAP / subagents / hindsight | **Non-goals** | Seepient is a framework; cloning omp's 63k-line terminal-only surface sacrifices SDK/Server/gateway/comms breadth. |

---

## Phased Plan (Tracks 0–4)

Each phase is independently shippable. Dependencies are explicit. **Every item has verifiable success criteria** (cross-referenced to quickstart.md).

### Phase 1 — T0: Streaming polish (quick wins, current stack)

**Risk**: low. **Effort**: ~1 week. **Depends on**: nothing. **Unblocks**: T4-3 (thinking indicator needs throttle).

| ID | Task | Files | Verify |
|---|---|---|---|
| T0-1 | Throttle `setStreamingText`/`setStreamingTool` to ~30fps via ref-buffer + `setTimeout(33ms)` flush; clear on commit/abort | `hooks/use-agent.ts`, new `stream-flush.ts` | T0-V1 |
| T0-2 | `React.memo` on `AssistantMessage`, `ToolCallBlock`, `UserMessage`, `InfoMessage`, `ErrorMessage`, `GoalStatus`, `LogoBanner`, `DiffViewer` | each component | T0-V3 |
| T0-3 | Hide cursor (`\x1b[?25l`) on `isRunning && !pendingPermission`; restore on idle. New `useCursor` hook | new `hooks/use-cursor.ts`, wired in `app.tsx` | T0-V2 |
| T0-4 | Audit `ink-reset.ts`: document Ink-internals deps, add version-drift guard (warn, not throw), wrap in try/catch | `ink-reset.ts` | T0-V4 |

**Phase 1 exit gate**: `pnpm test` green; manual streaming in iTerm2/Ghostty/tmux shows materially reduced flicker; cursor hidden during streaming. Renderer decision (research.md R1) **stays "Ink"** unless Phase 1–3 prove insufficient.

---

### Phase 2 — T4-1 + T4-2: ChatBlock + Widget host (T1 foundation)

**Risk**: medium (new contracts). **Effort**: ~1.5 weeks. **Depends on**: Phase 1 (throttle unblocks thinking indicator, but ChatBlock itself is throttle-independent). **Unblocks**: T1, T4-3.

| ID | Task | Files | Contract |
|---|---|---|---|
| T4-1 | `BlockEntry` type + `FeedEntry` union extension | `types.ts` | feed-lifecycle.md §1 |
| T4-1 | `ChatBlockInstance` + `ChatBlockHost` interfaces; `useFeed` extension (`mountBlock`/`updateBlock`/`finalizeBlock`/`disposeBlock`) | new `chat-block.ts`, `hooks/use-feed.ts` | feed-lifecycle.md §2-3 |
| T4-1 | `<MessageArea>` live/static split: finalized blocks → `<Static>`; unfinalized → live region | `components/message-area.tsx` | feed-lifecycle.md §4 |
| T4-1 | Cleanup on unmount: `useBlockCleanup` disposes all live blocks | new `hooks/use-block-cleanup.ts` | feed-lifecycle.md §7 |
| T4-1 | Tests: mount/update/finalize/dispose idempotency; cleanup counter on unmount | `__tests__/chat-block.test.ts` | T1-V4 |
| T4-2 | `WidgetHost` class: `mount(spec)` → `ChatBlockInstance`; `dispatchAction(widgetId, actionId, state)` → `submit(synthetic)` | new `widget-host.ts` | widget-protocol.md §4-6 |
| T4-2 | `useAgent` integration: branch on `render_widget` tool call (parallel to `manage_todos`); call `widgetHost.mount` | `hooks/use-agent.ts` | widget-protocol.md §4 |

**Phase 2 exit gate**: `ChatBlockInstance` lifecycle verified; a stub widget (no renderer yet) mounts, updates, finalizes, disposes without leaks. No widget rendering in this phase — that's Phase 3.

---

### Phase 3 — T1: Generative widgets (the vision)

**Risk**: medium. **Effort**: ~2 weeks. **Depends on**: Phase 2. **Unblocks**: nothing further (this is the user's core ask).

| ID | Task | Files | Contract |
|---|---|---|---|
| FR-1 | `render_widget` tool module + `parseWidgetSpec` boundary validator + `WidgetError` codes | new `tools/widgets.ts`, `errors.ts` | widget-protocol.md §1-2 |
| FR-1 | Tool registration in static registry (risk: `safe`) | `tools/index.ts` | widget-protocol.md §1 |
| FR-1 | Per-kind prop schema validators (9 kinds) | `tools/widgets.ts` | data-model.md §3 |
| FR-2 | `WidgetBlock` skeleton component (bordered `<Box>` + title + action bar) + kind dispatch | new `widgets/widget-block.tsx` | widget-protocol.md §5 |
| FR-2 | 9 kind renderers: table, keyvalue, chart, tree, panel, diff (delegates to `DiffViewer`), form, product_card, status_grid | new `widgets/*.tsx` | data-model.md §3 |
| FR-4 | Action bar: focus navigation (Tab/↑↓), Enter dispatches `WidgetActionDispatch` → `submit(synthetic)` | `widgets/widget-block.tsx`, `widget-host.ts` | widget-protocol.md §6 |
| FR-5 | One-shot vs multi-action finalization: one-shot finalizes after action; multi-action stays live until turn end | `widget-host.ts` | widget-protocol.md §6 |
| FR-5 | `feed-serializer.ts` resume: rebuild widget blocks from persisted `render_widget` tool calls as **finalized, non-interactive** | `feed-serializer.ts` | widget-protocol.md §7 |
| NFR-1 | Render budget: profile each kind; <50ms | tests | T1-V1 |
| Test | Tool: valid/invalid payloads; round-trip; lifecycle | `src/tools/__tests__/widgets.test.ts`, `__tests__/widget-block.test.tsx` | T1-V1, T1-V4 |

**Phase 3 exit gate**: the ecommerce product-card scenario (E2E-1) works — agent emits `render_widget`, widget renders, "Buy" action round-trips as a new turn. Session resume shows the widget finalized.

**L1 palette only.** L2 (layout DSL) and L3 (executable) explicitly deferred (spec.md non-goals).

---

### Phase 4 — T3: Hash-anchored edits (highest leverage, independent)

**Risk**: medium (tool contract change). **Effort**: ~2 weeks. **Depends on**: nothing.

> **Note**: technically **parallel to Phases 2–3** (orthogonal dependencies). The phase number reflects organizational ordering (it follows Phase 3 in this document), not a sequencing constraint — Phase 4 can start as soon as Phase 1 lands, in parallel with Phases 2 and 3.

| ID | Task | Files | Contract |
|---|---|---|---|
| FR-7 | `SnapshotStore` (record/resolve/verify/snapshot/clear) | new `core/hashline/snapshot-store.ts` | hashline-edit.md §3 |
| FR-7 | Grammar + parser: `[PATH#TAG]` sections, SWAP/DEL/INS/MV/REM ops, `+body` rows | new `core/hashline/{grammar.md,parser.ts}` | hashline-edit.md §2 |
| FR-7 | Patcher: apply ops, atomic write (per 006), 3-way merge on stale anchor | new `core/hashline/patcher.ts` | hashline-edit.md §5 |
| FR-7 | `HashlineError` codes (NO_STORE/UNKNOWN_TAG/STALE_ANCHOR/PARSE_ERROR/OUT_OF_RANGE) | `core/errors.ts` | hashline-edit.md "Error codes" |
| FR-7 | `edit_file` tool module; returns `FileWriteMetadata` (single-file) or `{edits:[]}` (multi-file) | new `tools/edit-file.ts` | hashline-edit.md §4-6 |
| FR-7 | `read_file`/`write_file` extended: record into store (optional chaining; no-op if absent) | `tools/core.ts` | hashline-edit.md §4 |
| FR-7 | CLI bootstrap: create session `SnapshotStore`, pass via tool-executor config | `adapters/cli/bootstrap.ts` | hashline-edit.md §3 |
| FR-7 | Register `edit_file` in tool registry (risk: `edit`) | `tools/index.ts` | hashline-edit.md §1 |
| FR-7h | `stripTrailingUnbalancedRemoval(diff)` utility; applied before commit (hashline-specific stabilization) | new `stream-commit-gate.ts` | research.md R9 |
| Test | Parser, patcher (apply/stale/unknown/malformed), snapshot store round-trip | `core/hashline/__tests__/*` | T3-V1 |

**Phase 4 exit gate**: the agent edits a 500-line file via a 6-line patch; `DiffViewer` shows the change; token usage ≥5× smaller than `write_file`. `write_file` still works (backward compat).

---

### Phase 5 — T2 + T4 remainder: Rendering/editor foundation + parity

**Risk**: low–medium. **Effort**: ~2 weeks. **Depends on**: Phase 1 (T2 builds on throttle), Phase 2 (T4 components mount via ChatBlock). **Note**: T2 items marked "Ink-bounded" — full fidelity deferred with the renderer.

| ID | Task | Files | Verify |
|---|---|---|---|
| FR-9 | Enrich `Markdown`: GFM table re-align during stream, fenced-code dim styling. Full syntax highlight + LaTeX **deferred** | `components/markdown.tsx` | T2-V2 |
| FR-10 | `isLiveReflowingMarkdown(text)` — hold open mermaid/table out of `<Static>` until stable | new `stream-commit-gate.ts`, wired into `use-agent.ts` commit | T2-V1 |
| FR-8 | Multiline editor (Ink-bounded): multi-line `TextInput` with word-wrap + bracketed-paste detection. omp-level editor **deferred** (needs renderer) | `components/text-input.tsx` extended | manual paste test |
| NFR-2 | Flicker "virtually imperceptible" at 100 tok/s in iTerm2/Ghostty (Ink-bounded ceiling — hard zero-flicker deferred; research.md R1). Document the ceiling in `research.md`. | manual | T2-V3 |
| T4-3 | Thinking indicator: eased starburst (8 frames, raised-cosine dwell 70–230ms) + windowed tok/s speed badge. Mounts via `ChatBlock('thinking')` | new `components/thinking-indicator.tsx` | T4-V1 |
| T4-4 | `TabBar` component (foundation for multi-pane; smoke-test only) | new `components/tab-bar.tsx` | T4-V2 |
| T4-5 | `plan-review-overlay` (foundation; not full plan mode) | new `components/plan-review-overlay.tsx` | T4-V3 |
| T4-6 | `TruncatedText` width-aware helper (extract from `tool-call-block.ts` inline) | new `components/truncated-text.tsx` | smoke |
| T4-7 | `notify()` toast (non-feed flash) via `ChatBlock('custom')` | new `components/toast.tsx` | smoke |

**Phase 5 exit gate**: rich markdown renders, streaming doesn't commit half-rendered tables, thinking indicator animates. omp-level editor + hard zero-flicker documented as **deferred pending renderer decision**.

---

### Phase 6 (deferred) — T4-8/T4-9 + renderer re-evaluation

Not scheduled. Triggered by re-evaluation after Phases 1–5:

| Item | Trigger |
|---|---|
| T4-8 `agent-dashboard` | real user demand for a dashboard surface |
| T4-9 controller refactor (`input-controller`/`event-controller` from `app.tsx`) | `app.tsx` exceeding ~600 LOC or T1 adding significant input-handling complexity |
| Custom differential renderer (omp `pi-tui` port) | T0 throttle + T1 widgets deemed insufficient for the polish bar |
| Inline images (Kitty/Sixel/iTerm2) | generative widgets need photographic content (e.g. `take_screenshot` inline) |
| LSP / DAP / subagents / hindsight / plan-mode-full | separate specs, each with own motivation |

---

## Dependency graph

```
Phase 1 (T0) ──────────────────────────────────► T4-3 (needs throttle)
                                              │
Phase 2 (T4-1 ChatBlock + T4-2 WidgetHost) ◄──┘
   │
   ├──► Phase 3 (T1 widgets)  ──► E2E-1 generative UI
   │
   └──► Phase 5 (T4-3 thinking, T4-4..7)

Phase 4 (T3 hashline) ── independent, parallel to 2/3 ──► ships anytime

Phase 5 (T2 + T4 remainder) ◄── Phase 1 (throttle) + Phase 2 (ChatBlock)

Phase 6 (deferred) ◄── re-evaluation after 1–5
```

**Critical path to the user's vision**: Phase 1 → Phase 2 → Phase 3. That sequence delivers generative interactive widgets on the current Ink stack.

**Highest-leverage independent item**: Phase 4 (hashline) — ships in parallel, no dependencies, biggest coding-interaction improvement.

---

## Done When

- [ ] Phase 1 (T0) shipped: throttle, memo, cursor hide, ink-reset audit — tests green, flicker reduced
- [ ] Phase 2 (T4-1/T4-2) shipped: ChatBlock lifecycle + widget host — lifecycle tests pass
- [ ] Phase 3 (T1) shipped: `render_widget` L1 palette, action round-trip — E2E-1 passes
- [ ] Phase 4 (T3) shipped: hashline patcher + `edit_file` — T3-V1/V2 pass, `write_file` retained
- [ ] Phase 5 (T2 + T4-3..7) shipped: markdown/streaming-gate/multiline + parity components
- [ ] All backward-compatibility rows (006, existing tools) verified
- [ ] `pnpm test` green across all new + existing tests
- [ ] Deferred items (Phase 6) documented with their re-evaluation triggers
- [ ] `CLAUDE.md` / `AGENTS.md` updated with new module locations (`src/core/hashline/`, `tui/widgets/`, `tui/chat-block.ts`)
