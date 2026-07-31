# Implementation Plan: Inline Diff Viewer + Safe Write (T051)

**Branch**: `006-inline-diff-viewer` (create from `feature/tui-upgrade-prd`) | **Date**: 2026-06-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature spec `specs/006-inline-diff-viewer/spec.md` (derived from `docs/todo/deferred-tui-items.md` T051). Phase artifacts: [research.md](./research.md), [data-model.md](./data-model.md), [contracts/tool-result-metadata.md](./contracts/tool-result-metadata.md), [quickstart.md](./quickstart.md).

## Summary

Make `write_file` crash-safe and show what changed. Two coupled changes: (1) a
**safe write** — atomic temp-file + `fs.rename` with old-content capture — so a
failed/crashed write never corrupts a file; (2) an **inline diff viewer** that
renders the change as a unified diff in the tool-call block. The diff engine is
the [`diff`](https://www.npmjs.com/package/diff) package (the same engine the Pi
coding agent uses — see research.md R1); the safe-write is seepient-original (Pi's
`write` is neither atomic nor diff'd).

The load-bearing change is a **tool-result metadata channel** that already
half-exists: `ToolResult.metadata` and `execute → string | ToolResult` are
defined but the metadata is discarded at the `tool()` factory and `executeTool`
returns a bare string. T051 threads metadata through `executeTool` → `agent-loop`
→ `StepResult.metadata` → TUI, reusing the existing type (single source of
truth) rather than inventing a parallel shape.

## Technical Context

**Language/Version**: TypeScript, `tsc` → ES2022 / NodeNext, no bundler, dev via `tsx`.

**Primary Dependencies**: existing stack + **`diff@9`** (BSD-3-Clause, zero transitive deps, ~30 KB; ships its own types). Justified in research.md R1 — domain-standard engine, reference product (Pi) depends on it; not a "one-helper utility package."

**Storage**: none — in-memory metadata channel + a UI component. No schema, no migration, no `SessionData` change.

**Testing**: Vitest. New: `src/tools/__tests__/write-file.test.ts` (atomic write), `src/adapters/cli/tui/__tests__/diff-viewer.test.ts` (`ink-testing-library` render). The existing Vitest suite (~287 tests / 28 files) must stay green. (AGENTS.md's "161/10" count is stale — corrected in T017.)

**Target Platform**: Node 20+ on macOS/Linux/Docker (CLI TUI). POSIX-atomic `fs.rename`.

**Project Type**: library + CLI (existing).

**Performance Goals**: diff is bounded by size caps (64 KB / 2000 lines → skip), so diff compute is O(file) worst case and never blocks the TUI.

**Constraints**: metadata must never enter message history (no LLM context bloat); backward compatible (tools returning strings render unchanged).

**Scale/Scope**: ~7 source files touched; 3 of them are 1–10 line contract changes. Estimated ~180–220 lines including tests.

## Constitution Check

*Gate: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Note |
|---|---|---|
| **I. Single Execution Engine & Layered Boundaries** | ✅ Pass | Metadata flows Core→Presentation only (`StepResult.metadata` read by the TUI). No adapter reimplements the loop. Tools (Infrastructure) emit metadata through Core; no reverse dependency. |
| **II. Single Source of Truth** | ✅ Pass | Reuses the existing `ToolResult.metadata` definition end-to-end — no parallel `{output, metadata}` shape invented. Diff logic lives in one owner module (`tui/diff/`). |
| **III. Simplicity First** | ✅ Pass | `diff` package instead of a hand-rolled LCS (correctness). Atomic write is minimal (temp+rename). No `.bak`, no locking, no configurability beyond the size cap. Deferred items explicit in spec. |
| **IV. Surgical Changes** | ✅ Pass | `executeTool` return-type widening is the one slightly larger item but contained to 3 lines in `agent-loop.ts` (verified). Every changed file traces to a user-story criterion. |
| **V. Safe by Default & Verifiable** | ✅ Pass | Atomic write = predictable failure (original intact). Each story has a failing-test-first verification (quickstart.md Scenarios 3, 6, 7). |

No violations. Complexity Tracking table (below) left empty.

## Project Structure

### Documentation (this feature)

```text
specs/006-inline-diff-viewer/
├── plan.md              # this file
├── research.md          # R1–R6 decisions (engine, channel, atomic write, caps, CRLF, isolation)
├── data-model.md        # ToolResult, StepResult.metadata, FileWriteMetadata, DiffViewLine
├── quickstart.md        # 7 validation scenarios
├── contracts/
│   └── tool-result-metadata.md   # the in-process boundary contract
└── tasks.md             # (next: /speckit-tasks)
```

### Source code (repository root) — touched files

```text
src/
├── core/
│   ├── types.ts                      # +StepResult.metadata?  (1 field)
│   ├── tool-executor.ts              # executeTool → Promise<ToolResult>; factory preserves metadata
│   └── agent-loop.ts                 # 3 call sites read .output + attach .metadata to step
├── tools/
│   ├── interface.ts                  # ToolModule.handler: Promise<string | ToolResult>
│   ├── core.ts                       # WriteFileTool: atomic write + old-capture → ToolResult; exports FileWriteMetadata (producer owns the type)
│   └── __tests__/write-file.test.ts  # NEW — atomic crash-safety + new-file + edit
└── adapters/cli/tui/
    ├── diff/                         # NEW owner module
    │   ├── file-write-meta.ts        # isFileWriteMetadata() guard (type-only import of FileWriteMetadata from tools/core)
    │   └── line-diff.ts              # diffLines → DiffViewLine[] (CRLF-normalize, collapse)
    ├── components/
    │   ├── diff-viewer.tsx           # NEW — renders DiffViewLine[] (green/red/dim, collapse/expand)
    │   └── tool-call-block.tsx       # write_file + metadata → <DiffViewer/>; else unchanged
    ├── hooks/use-agent.ts            # copy step.metadata → ToolCallEntry.metadata
    ├── types.ts                      # +metadata?: unknown on ToolCallEntry
    └── __tests__/diff-viewer.test.ts # NEW — ink-testing-library render snapshot
```

**Structure decision**: diff logic owns `src/adapters/cli/tui/diff/` (one concept = one owner). The `FileWriteMetadata` *type* is owned by its producer — exported from `src/tools/core.ts` next to `WriteFileTool` (single source of truth; compile-checked where it's created). Only the *parse guard* (`isFileWriteMetadata`) is TUI-side (`tui/diff/file-write-meta.ts`), via a type-only import — Adapter→Infrastructure is the allowed dependency direction and the import is erased at runtime. Core still carries an opaque `metadata` bag on `StepResult`; the typed contract is negotiated between producer and consumer. The `diff` package is imported in exactly one place (`line-diff.ts`).

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified.

*(Empty — no violations.)*

## Build sequence (implementation strategy — MVP first)

MVP = **US1 (safe write + metadata channel)**, which delivers corruption safety
independently of any UI. US2 (diff viewer) builds on the channel.

1. **Channel (core)** — widen types: `StepResult.metadata?`, `ToolModule.handler → string | ToolResult`, `executeTool → Promise<ToolResult>` (preserve metadata, fix factory drop). Loop: 3 call sites attach `metadata`. → *verify: `pnpm build` + existing tests green (backward compat).*
2. **Safe write (US1)** — rewrite `WriteFileTool.handler`: read-old → temp-write → rename → `ToolResult{output, metadata: FileWriteMetadata}`. Temp cleanup on failure. → *verify: quickstart Scenario 3 (rename-throws test) — original intact.*
3. **Diff owner module (US2)** — `tui/diff/`: `isFileWriteMetadata` guard (the `FileWriteMetadata` type is already exported from `tools/core.ts` in step 2); `line-diff.ts` (`Diff.diffLines`, CRLF-normalize, collapse → `DiffViewLine[]`). → *verify: unit test diff-parts → view-lines.*
4. **DiffViewer + wiring (US2)** — `diff-viewer.tsx` (Pi-style collapse/expand); `tool-call-block.tsx` branches on `write_file` + parsed metadata; `use-agent` copies `step.metadata`. → *verify: quickstart Scenarios 1, 2, 4, 5, 7.*
5. **Polish** — size-cap skip path, `... N more` affordance, `pnpm test` green, `docs/todo/deferred-tui-items.md` T051 marked done.

> Detailed per-file tasks with IDs/labels are generated next via `/speckit-tasks`.

## Post-design constitution re-check

All five principles still hold after the design is concrete: the metadata
channel reuses one type (II), touches a contained set of files (IV), adds one
justified dependency (III), and every step is test-gated (V). No amendment to
the constitution or its templates is required.
