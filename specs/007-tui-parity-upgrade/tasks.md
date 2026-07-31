# Tasks: TUI Parity & Generative Widget Upgrade

**Phase 2 output.** Implementation tasks derived from `plan.md`. Each task is phased, dependency-ordered, and traceable to a contract section and a quickstart validation. Refine with `/speckit-tasks` if finer granularity is needed.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[-]` deferred

---

## Phase 1 — T0: Streaming polish

- [x] **T0-1** Throttle streaming flush to ~30fps
  - Files: `src/adapters/cli/tui/stream-flush.ts` (new), `src/adapters/cli/tui/hooks/use-agent.ts`
  - Mechanism: accumulate `text_delta`/`tool_progress` in refs; `setTimeout(33ms)` flush → `setState`; clear timer on commit/abort/finally
  - Contract: research.md R2
  - Verify: quickstart T0-V1 — **deferred: implementation wired (`stream-flush.ts` used in `use-agent.ts:90-91`); the render-count probe test `__tests__/use-agent-throttle.test.ts` is not yet written. Re-evaluate when a flicker regression surfaces.**

- [x] **T0-2** `React.memo` on frozen-history components
  - Files: `components/{assistant-message,tool-call-block,user-message,info-message,error-message,goal-status,logo-banner,diff-viewer}.tsx`
  - Note: feed entries are immutable after append → default shallow compare is correct
  - Contract: research.md R3
  - Verify: T0-V3 — **deferred: all 8 components carry `React.memo`; the render-count probe `__tests__/memo.test.tsx` is not yet written. Re-evaluate when a re-render regression surfaces.**

- [x] **T0-3** Cursor hide during streaming
  - Files: `src/adapters/cli/tui/hooks/use-cursor.ts` (new), `app.tsx` (wire)
  - Mechanism: `useEffect` writes `\x1b[?25l`/`\x1b[?25h` to `process.stdout` keyed on `isRunning && !pendingPermission`
  - Contract: research.md R4
  - Verify: T0-V2

- [x] **T0-4** `ink-reset.ts` audit + harden
  - Files: `src/adapters/cli/tui/ink-reset.ts`
  - Mechanism: document Ink-internals deps; version-drift guard (warn); try/catch wrap
  - Contract: research.md R5
  - Verify: T0-V4 — **deferred: `guardInkVersion()` wired in `index.tsx:212`; the guard test `__tests__/ink-reset-guard.test.ts` is not yet written. Re-evaluate on Ink version bump.**

**Phase 1 gate**: `pnpm test` green; manual flicker reduced in iTerm2/Ghostty/tmux.

---

## Phase 2 — T4-1 + T4-2: ChatBlock + Widget host

- [x] **T4-1a** `BlockEntry` type + `FeedEntry` union extension
  - Files: `src/adapters/cli/tui/types.ts`
  - Contract: feed-lifecycle.md §1

- [x] **T4-1b** `ChatBlockInstance` + `ChatBlockHost`; `useFeed` extension
  - Files: `src/adapters/cli/tui/chat-block.ts` (new), `hooks/use-feed.ts`
  - API: `mountBlock(blockKind, props)`, `updateBlock(id, props)`, `finalizeBlock(id)`, `disposeBlock(id)`
  - Invariants: finalize/dispose idempotent; update no-op after finalize; cleanups run once
  - Contract: feed-lifecycle.md §2-3

- [x] **T4-1c** `<MessageArea>` live/static split for `BlockEntry`
  - Files: `components/message-area.tsx`
  - Rule: `finalized:true` → `<Static>`; `finalized:false` → live region
  - Contract: feed-lifecycle.md §4

- [x] **T4-1d** `useBlockCleanup` — dispose all live blocks on `TuiApp` unmount — **now inline at `app.tsx:94` (`useEffect(() => () => widgetHost.disposeAll(), [widgetHost])`); the hook file was deleted**
  - Files: `hooks/use-block-cleanup.ts` (new)
  - Contract: feed-lifecycle.md §7

- [x] **T4-1e** Tests: lifecycle, idempotency, cleanup counter
  - Files: `__tests__/chat-block.test.ts`
  - Verify: T1-V4 — **`chat-block.test.ts` written: mount/update/finalize/dispose idempotency, cleanup-once, cleanup-throws-isolation (12 tests).**

- [x] **T4-2a** `WidgetHost` class: `mount(spec) → ChatBlockInstance`; `dispatchAction(widgetId, actionId, state)`
  - Files: `src/adapters/cli/tui/widget-host.ts` (new)
  - Contract: widget-protocol.md §4-6

- [x] **T4-2b** `useAgent.onStep` branch for `render_widget` (parallel to `manage_todos`); call `widgetHost.mount`
  - Files: `hooks/use-agent.ts`
  - Contract: widget-protocol.md §4 — **wired at `use-agent.ts:181-189` (reads `step.metadata.spec`, calls `widgetHost.mount`).**

**Phase 2 gate**: stub widget mounts/updates/finalizes/disposes without leaks (T1-V4). No renderers yet.

---

## Phase 3 — T1: Generative widgets

- [x] **FR-1a** `WidgetError` codes in `errors.ts`
  - Codes: `WIDGET_INVALID_KIND`, `WIDGET_INVALID_PROPS`, `WIDGET_DUPLICATE_ACTION` (all `retryable: true`)
  - Contract: widget-protocol.md §2

- [x] **FR-1b** `parseWidgetSpec` boundary validator + 9 per-kind prop schemas
  - Files: `src/tools/widgets.ts` (new)
  - Kinds: table, keyvalue, chart, tree, panel, diff, form, product_card, status_grid

- [x] **FR-1c** `render_widget` tool module + registration (risk: `safe`)
  - Files: `src/tools/widgets.ts`, `src/tools/index.ts`
  - Returns `ToolResult` with `metadata: { spec }` (006 pattern)
  - Contract: widget-protocol.md §1-2

- [x] **FR-2a** `WidgetBlock` skeleton (bordered `<Box>` + title + action bar) + kind dispatch
  - Files: `src/adapters/cli/tui/widgets/widget-block.tsx` (new)
  - Contract: widget-protocol.md §5

- [x] **FR-2b** 9 kind renderers
  - Files: `widgets/{table,keyvalue,chart,tree,panel,diff,product-card,status-grid,form}.tsx`
  - `diff` delegates to existing `DiffViewer`
  - `product_card` interactive (keyboard-focus actions)
  - Contract: data-model.md §3

- [x] **FR-4** Action dispatch: Tab/↑↓ nav, Enter → `WidgetActionDispatch` → `submit(synthetic)`
  - Files: `widgets/widget-block.tsx`, `widget-host.ts`
  - Synthetic format: `[widget:<id>] action "<actionId>" state {...}`
  - Contract: widget-protocol.md §6

- [x] **FR-5a** One-shot vs multi-action finalization
  - Files: `widget-host.ts`
  - Rule: one-shot (form, single-action) finalizes after action; multi-action stays live until turn end
  - Contract: widget-protocol.md §6

- [x] **FR-5b** `feed-serializer.ts` resume: rebuild widget blocks as finalized/non-interactive
  - Files: `feed-serializer.ts`
  - Contract: widget-protocol.md §7
  - Verify: **E2E-2** (session resume preserves finalized widgets; non-widget blocks dropped as transient)

- [-] **FR-1/2/4 tests** Valid/invalid payloads, round-trip, lifecycle
  - Files: `src/tools/__tests__/widgets.test.ts`, `__tests__/widget-block.test.tsx`
  - Verify: T1-V1, T1-V4, E2E-1
  - **Status: tool-layer + host-layer tests exist (`widget-spec.test.ts` 14 tests, `widget-action.test.ts` 5 tests, `chat-block.test.ts` 12 tests). The React-component render test `widget-block.test.tsx` (ink-testing-library) is deferred — re-evaluate when widget input/keyboard behavior changes.**

**Phase 3 gate**: ecommerce product-card scenario works end-to-end (E2E-1).

---

## Phase 4 — T3: Hash-anchored edits (parallel to 2/3)

- [x] **FR-7a** `SnapshotStore` (record/resolve/verify/snapshot/clear)
  - Files: `src/core/hashline/snapshot-store.ts` (new)
  - Contract: hashline-edit.md §3

- [x] **FR-7b** Patch grammar doc + parser — **grammar lives in system prompt (HASHLINE GRAMMAR section) + tool description + parser.ts; no standalone grammar.md. Ops: SWAP A.=B:, SWAP.BLK A:, DEL A.=B, DEL.BLK A, INS.PRE/POST/HEAD/TAIL:. MV/REM deferred (rejected at parse time with "not yet implemented"). +body rows.**
  - Contract: hashline-edit.md §2

- [x] **FR-7c** Patcher (apply + atomic write + 3-way merge recovery)
  - Files: `src/core/hashline/patcher.ts` (new)
  - Reuses 006 `atomicWrite` (temp + `fs.rename`)
  - Contract: hashline-edit.md §5

- [x] **FR-7d** `HashlineError` codes (NO_STORE/UNKNOWN_TAG/STALE_ANCHOR/PARSE_ERROR/OUT_OF_RANGE)
  - Files: `src/core/errors.ts`
  - Contract: hashline-edit.md "Error codes"

- [x] **FR-7e** `edit_file` tool module; single-file `FileWriteMetadata` + multi-file `{edits:[]}`
  - Files: `src/tools/edit-file.ts` (new), `src/tools/index.ts`
  - Risk: `edit` (same as `write_file`)
  - Contract: hashline-edit.md §4-6

- [x] **FR-7f** `read_file`/`write_file` record into `SnapshotStore` (optional chaining)
  - Files: `src/tools/core.ts`
  - Backward compatible: no-op if store absent
  - Contract: hashline-edit.md §4

- [x] **FR-7g** CLI bootstrap creates session `SnapshotStore`, passes via tool-executor config
  - Files: `src/adapters/cli/bootstrap.ts`
  - Contract: hashline-edit.md §3

- [x] **FR-7h** `stripTrailingUnbalancedRemoval(diff)` utility (hashline-specific stabilization) — **implemented in `stream-commit-gate.ts`; applied at display layer in `app.tsx:410` via `stabilizeStreamingText`.**
  - Files: `src/adapters/cli/tui/stream-commit-gate.ts`

- [x] **FR-7 tests** Parser, patcher (apply/stale/unknown/malformed), snapshot store
  - Files: `src/core/hashline/__tests__/{parser,patcher,snapshot-store}.test.ts`
  - Verify: T3-V1

**Phase 4 gate**: 500-line file edited via 6-line patch; `DiffViewer` reuses; token ≥5× smaller; `write_file` retained.

---

## Phase 5 — T2 + T4 remainder

- [x] **FR-9** Enrich `Markdown` (GFM table re-align, fenced-code dim). Full syntax highlight + LaTeX deferred
  - Files: `components/markdown.tsx`
  - Verify: T2-V2

- [x] **FR-10** `isLiveReflowingMarkdown(text)` — gate live display for open fence/table/trailing-diff — **implemented at the display layer in `app.tsx:410` via `stabilizeStreamingText` (NOT at `commitStreaming`, which is a structural boundary). The full streaming text is always committed to feed history; this gate only controls what the live region shows while reflowing.**
  - Files: `src/adapters/cli/tui/stream-commit-gate.ts`, wired in `app.tsx`
  - Verify: T2-V1

- [ ] **FR-8** Multiline `TextInput` (Ink-bounded) with word-wrap + bracketed-paste detection
  - Files: `components/text-input.tsx` extended
  - **Acceptance**: ≥10-line paste doesn't truncate or break layout; Shift+Enter inserts a newline; word-wrap at terminal width; ↑/↓ navigate lines when multi-line.
  - Note: omp-level editor (kill-ring, magic keywords, IME, image refs) deferred (needs renderer)
  - Verify: manual paste test

- [ ] **NFR-2** Verify "virtually imperceptible" flicker at 100 tok/s; document Ink ceiling
  - Verify: T2-V3

- [-] **T4-3** Thinking indicator (eased starburst + speed badge) via `ChatBlock('thinking')` — **deferred: component exists but nothing mounts it; `message-area.tsx` has no `blockKind: 'thinking'` branch.**
  - Files: `components/thinking-indicator.tsx` (new)
  - Verify: T4-V1

- [~] **T4-4** `TabBar` (multi-pane foundation) — **scaffold only; not mounted**
  - Files: `components/tab-bar.tsx` (new)
  - Verify: T4-V2

- [~] **T4-5** `plan-review-overlay` (foundation; not full plan mode) — **scaffold only; not mounted**
  - Files: `components/plan-review-overlay.tsx` (new)
  - Verify: T4-V3

- [x] **T4-6** `TruncatedText` width-aware helper (extract from `tool-call-block.ts`) — **`tool-call-block.tsx` now imports and uses `TruncatedText` (args preview + output truncation).**
  - Files: `components/truncated-text.tsx`

- [-] **T4-7** `notify()` toast via `ChatBlock('custom')` — **deferred: component exists but no `notify()` is exported; nothing mounts it**
  - Files: `components/toast.tsx` (new)

**Phase 5 gate**: markdown/streaming-gate/multiline + parity components shipped; Ink-bounded ceilings documented.

---

## Phase 6 — Deferred (re-evaluation triggers documented in plan.md)

- [-] **T4-8** `agent-dashboard` — when real demand surfaces
- [-] **T4-9** Controller refactor (`input-controller`/`event-controller` from `app.tsx`) — when `app.tsx` > ~600 LOC
- [-] Custom differential renderer (omp `pi-tui` port) — when T0+T1 polish insufficient
- [-] Inline images (Kitty/Sixel/iTerm2) — when widgets need photographic content
- [-] LSP / DAP / subagents / hindsight / full-plan-mode — separate specs

---

## Documentation updates (do during implementation, not after)

- [x] `AGENTS.md` — add `src/core/hashline/` to Key Files; add `edit_file` to tools list; add `render_widget`; add `tui/widgets/` + `tui/chat-block.ts` to TUI notes
- [x] `ARCHITECTURE.md` — add hashline module to Source Layout; note `edit_file` in Tools tier table; note widget system in CLI adapter section
- [x] `CHANGELOG.md` — entry per phase shipped

## Done-when checklist (mirrors plan.md)

- [ ] Phases 1–5 shipped; all gates passed
- [ ] `pnpm test` green across new + existing
- [ ] Backward compatibility verified (006, `write_file`, existing tools)
- [ ] Deferred items (Phase 6) documented with triggers
- [ ] `AGENTS.md` / `ARCHITECTURE.md` updated
ed
