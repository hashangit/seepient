# Quickstart: Validation Guide

**Phase 1 output.** Runnable scenarios that prove each track works end-to-end. Per speckit convention, this is a validation *guide* — implementation bodies live in `tasks.md`, contracts in `contracts/`, types in `data-model.md`.

## Prerequisites

```sh
# from repo root
pnpm install            # AGENTS.md: use pnpm, not npm
pnpm build              # or: pnpm dev (tsx, instant feedback)
```

A provider API key in env (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GLM_API_KEY`) or `~/.seepient/setting.json`.

The TUI launches in a TTY:
```sh
pnpm dev                # interactive — Ink TUI (TTY), else readline REPL
```

Tests: `pnpm test` (Vitest, matching existing `src/adapters/cli/tui/__tests__/`).

---

## Track 0 — Streaming polish

### T0-V1 — Throttle reduces render count (automated)

**Covers**: QW-1 (30fps throttle)

```sh
pnpm test -- src/adapters/cli/tui/__tests__/use-agent-throttle.test.ts
```

**Expected**: a synthetic 100-tok/s `text_delta` burst produces ≤30 `setStreamingText` calls/sec sustained (transient spikes on commit/abort allowed); the final flush on commit emits the complete text.

Manual: launch `pnpm dev`, ask for a long enumerated list (forces continuous streaming), observe — the text crawls smoothly without full-frame flicker in iTerm2/Ghostty/tmux.

### T0-V2 — Cursor hidden while running

**Covers**: QW-2

Launch `pnpm dev`, submit a prompt. During streaming the hardware cursor is hidden (`\x1b[?25l`); on return to idle the cursor reappears (`\x1b[?25h`). Verify with `tmux` + `cat -v` if needed: no cursor-position sequences bleed during streaming.

### T0-V3 — Frozen history not re-rendered

**Covers**: QW-3 (`React.memo`)

```sh
pnpm test -- src/adapters/cli/tui/__tests__/memo.test.tsx
```

**Expected**: during a streamed turn, a render-count probe on `AssistantMessage`/`ToolCallBlock` for frozen `<Static>` rows shows zero re-renders.

### T0-V4 — ink-reset guard

**Covers**: QW-4

```sh
pnpm test -- src/adapters/cli/tui/__tests__/ink-reset-guard.test.ts
```

**Expected**: with Ink internals shape mocked to a drifted shape, `resetView()` logs a warning and does not throw; resize does not crash.

---

## Track 1 — Generative widgets

### T1-V1 — `render_widget` tool: valid + invalid (automated)

**Covers**: FR-1, FR-2 (tool, skeleton, palette)

```sh
pnpm test -- src/tools/__tests__/widgets.test.ts
```

**Expected**:
- `render_widget({id:'w1', kind:'table', props:{columns:['A','B'], rows:[[1,2]]}})` → `ToolResult.metadata.spec` is the parsed `WidgetSpec`; `output` is human-readable.
- `render_widget({id:'w1', kind:'bogus', props:{}})` → throws `WidgetError({code:'WIDGET_INVALID_KIND', retryable:true})`.
- `render_widget({id:'w1', kind:'table', props:{}})` → throws `WidgetError({code:'WIDGET_INVALID_PROPS'})`.

### T1-V2 — Widget mounts and renders (manual)

**Covers**: FR-2, FR-3, FR-5

Launch `pnpm dev`, prompt: *"Show me a comparison table of Redis vs Memcached."*

**Expected**: a bordered widget frame appears with title "Redis vs Memcached", a 2-column table inside; once finalized it scrolls with the feed (in `<Static>`). No wall of text.

### T1-V3 — Widget action round-trips (manual)

**Covers**: FR-4 (the load-bearing safety property)

Prompt: *"Show me a product card for a mechanical keyboard with a Buy button."*

**Expected**:
- A `product_card` widget renders with a "Buy now" action.
- Tab focuses the button; Enter activates it.
- A new user turn appears: `[widget:<id>] action "buy"` — the agent continues based on it.
- The widget freezes into history after the action (one-shot).

### T1-V4 — Block lifecycle (automated)

**Covers**: FR-3 (ChatBlock)

```sh
pnpm test -- src/adapters/cli/tui/__tests__/chat-block.test.ts
```

**Expected**:
- `mountBlock('widget', spec)` returns an active instance; `isActive === true`.
- `update(props)` patches the block; `<MessageArea>` re-renders it in the live region.
- `finalize()` sets `finalized:true`; subsequent `update()` is a no-op; cleanups run once.
- `dispose()` removes the entry; cleanups run once even if not finalized.
- On `TuiApp` unmount, all live blocks are disposed (no orphan timers — verify with a cleanup counter).

---

## Track 2 — Rendering & editor foundation

### T2-V1 — Streaming commit gating (automated)

**Covers**: FR-10 (`isLiveReflowingMarkdown`) and FR-7h (`stripTrailingUnbalancedRemoval`, hashline-specific)

```sh
pnpm test -- src/adapters/cli/tui/__tests__/stream-commit-gate.test.ts
```

**Expected**:
- `isLiveReflowingMarkdown("text\n```mermaid\ngraph LR;")` → `true` (open fence).
- `isLiveReflowingMarkdown("text\n```mermaid\n...\n```")` → `false` (closed).
- `stripTrailingUnbalancedRemoval("@@ -1,2 +1,1\n-a\n-b")` → `""` (trailing removals without adds trimmed).

### T2-V2 — Rich markdown renders (manual)

**Covers**: FR-9

Prompt: *"Show me a markdown doc with a table and a fenced code block."*

**Expected**: GFM table renders with aligned columns; fenced code is monospace + dim. (Full syntax highlighting + LaTeX are deferred — see plan.md Phase 4.)

### T2-V3 — Zero-flicker at 100 tok/s (manual)

**Covers**: NFR-2 (via throttle, not CSI 2026 — see research.md R1/R2)

Stream a 2000-token response in iTerm2 and Ghostty. Perceived flicker is materially reduced vs. pre-T0 baseline. (Hard zero-flicker requires the renderer port — deferred; throttle is the Ink-bounded ceiling.)

---

## Track 3 — Hash-anchored edits

### T3-V1 — Patcher: apply + stale-anchor (automated)

**Covers**: FR-7

```sh
pnpm test -- src/core/hashline/__tests__/patcher.test.ts
```

**Expected**:
- `[file.ts#a1b2]\nSWAP 1.=1:\n+new line` with matching hash → file content updated; single-section `FileWriteMetadata` returned (the common case).
- Same patch with a mismatched hash → `HashlineError({code:'HASHLINE_STALE_ANCHOR', retryable:true})`.
- Unknown tag → `HashlineError({code:'HASHLINE_UNKNOWN_TAG', retryable:false})`.
- Malformed grammar → `HashlineError({code:'HASHLINE_PARSE_ERROR', retryable:true})`.

### T3-V2 — `edit_file` tool renders diff (manual)

**Covers**: FR-7 end-to-end

In a project with a known file, prompt: *"Change line 3 of src/foo.ts from X to Y."*

**Expected**: the agent reads the file (records snapshot), calls `edit_file` with a hash-anchored patch, and the `DiffViewer` renders the change (reusing the 006 path). Token usage for the edit is dramatically lower than a whole-file `write_file`.

### T3-V3 — `write_file` fallback retained

**Covers**: backward compatibility

`write_file` for a new file still works (atomic, 006 contract). `edit_file` on an unread file fails with `HASHLINE_UNKNOWN_TAG` (acceptable — model should read first).

---

## Track 4 — Component parity

### T4-V1 — Thinking indicator (manual)

**Covers**: T4-3

Use a thinking-capable model; submit a non-trivial prompt.

**Expected**: while the model thinks (before streaming text), an eased starburst indicator animates with a tok/s speed badge; on first text token, it commits and text streams. (Ink-bounded — animation smoothness depends on T0 throttle.)

### T4-V2 — `TabBar` (manual, post-implementation)

**Covers**: T4-4

When multiple overlays or panes are open, a `TabBar` shows the active surface; Tab cycles. (Smoke test only — `TabBar` is a foundation for later multi-pane work.)

### T4-V3 — `plan-review-overlay` (manual, post-implementation)

**Covers**: T4-5

Trigger plan mode (future); the overlay renders the proposed plan with approve/reject. (Foundation for plan mode; not the full plan-mode feature.)

---

## Cross-track end-to-end

### E2E-1 — Generative UI with hashline edit

Prompt: *"Show me the current contents of src/foo.ts as a widget, then change line 5 to double its value."*

**Expected**: the agent (1) reads the file (snapshot recorded), (2) renders a `table` widget showing the lines, (3) calls `edit_file` with a hash-anchored patch, (4) the `DiffViewer` shows the change, (5) a second widget summarizes the result. All on the current Ink stack, no renderer port.

### E2E-2 — Session resume preserves finalized widgets

Render a widget, finalize it, then `/sessions` → resume.

**Expected**: the widget renders as finalized, non-interactive (actions visible but disabled). Live/unfinalized blocks are dropped (transient — see `contracts/feed-lifecycle.md`).

---

## Test mapping summary

| Track | New test files |
|---|---|
| T0 | `__tests__/use-agent-throttle.test.ts`, `__tests__/memo.test.tsx`, `__tests__/ink-reset-guard.test.ts` |
| T1 | `src/tools/__tests__/widgets.test.ts`, `__tests__/chat-block.test.ts` |
| T2 | `__tests__/stream-commit-gate.test.ts` |
| T3 | `src/core/hashline/__tests__/patcher.test.ts`, `src/core/hashline/__tests__/snapshot-store.test.ts` |

All new tests use Vitest + ink-testing-library (existing pattern from `__tests__/tool-call-block.test.tsx`).
