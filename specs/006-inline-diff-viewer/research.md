# Research — Inline Diff Viewer + Safe Write (T051)

**Phase 0 output.** Resolves every design unknown against the verified codebase
(see `plan.md` → Technical Context for the exact signatures read).

## R1 — Diff engine: use the `diff` npm package (not hand-rolled, not imported)

**Decision**: Depend on [`diff`](https://www.npmjs.com/package/diff) (`diff@9`
installed; BSD-3-Clause, zero transitive deps, ~30 KB, ships its own types). Use
`Diff.diffLines(old, new)` for the viewer; `Diff.createTwoFilesPatch` available
if we ever want raw patch text.

**Rationale**: Line-diff correctness on real source is non-trivial — minimal
hunk boundaries, Unicode, CRLF, whitespace-only runs. A ~60-line hand-rolled LCS
would almost certainly get an edge case subtly wrong. The **Pi coding agent**
(`@earendil-works/pi-coding-agent` v0.79.3, inspected on disk at
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`) ships the same
choice: its `core/tools/edit-diff.js` does `import * as Diff from "diff"`. We
learn from Pi's engine choice without importing its code.

**Why not import Pi's `edit-diff.js`**: it is **not part of Pi's public exports**
(`pi-coding-agent`'s `exports` map exposes only `"."`). It is also tightly
coupled to Pi's *edit* tool — fuzzy oldText matching, BOM stripping, CRLF
normalization for locating search text — none of which `write_file` needs
(write_file already has both full old+new contents). Importing would drag in
`typebox`, `proper-lockfile`, `@earendil-works/pi-tui`, and lock seepient to
another product's private internals. Constitution §II (single source of truth)
and the "don't wrap third-party internals" rule forbid it.

**Why not inline LCS (the PRD's original note)**: rejected for correctness risk
above. Reverses the PRD's "start with inline, add `diff` later" recommendation;
user ratified this on 2026-06-17.

**Dependency-justification (constitution §Dependencies)**: `diff` is a
purpose-built, domain-standard engine — not a "transitive utility package for
one helper." BSD, zero deps, tiny, and the reference product depends on it.

## R2 — Metadata channel: reuse the existing `ToolResult.metadata` end-to-end

**Decision**: Flow metadata through the channel that **already exists**:
- `ToolResult` (`src/core/types.ts:97`) already has `metadata?: Record<string, unknown>`.
- `UserToolDefinition.execute` already returns `Promise<string | ToolResult>`.
- Widen `ToolModule.handler` (`src/tools/interface.ts:25`) from `Promise<string>`
  to `Promise<string | ToolResult>` (built-ins keep returning strings; the
  `tool()` factory already handles both shapes).
- Change `executeTool` (`src/core/tool-executor.ts:188`) to return
  `Promise<ToolResult>` (normalize a bare string → `{ output, success: true }`);
  preserve `metadata` instead of discarding it (the `tool()` factory at
  `tool-executor.ts:146-149` currently drops it).
- The loop (`src/core/agent-loop.ts`) reads `result.output` + `result.metadata`
  and attaches metadata to the step.
- Add **top-level** `StepResult.metadata?: Record<string, unknown>`
  (`src/core/types.ts:48`).

**Rationale**: One metadata shape, one definition (constitution §II). Reusing
`ToolResult` avoids inventing a parallel `{ output, metadata }` type. Top-level
`StepResult.metadata` is generic enough to also carry T052 reasoning later.

**Ripple (verified)**: `executeTool` has exactly **3 call sites, all in
`agent-loop.ts`** (the autoConfirm / `decision==='auto'` / `approveTool`
branches), all assigning to the same local `output`. One import site. Contained.

## R3 — Atomic write: same-dir temp file + `fs.rename`

**Decision**: In `WriteFileTool.handler` (`src/tools/core.ts:100`):
1. `fs.readFile` the old content (best-effort; absent → new file).
2. Write to a temp file in the **same directory** (required for `rename` to be
   atomic — same filesystem): `${path}.${randomUUID().slice(0,8)}.tmp`.
3. `fs.rename(tmp, path)` — atomic on POSIX.
4. On any failure after temp creation: `fs.unlink(tmp)` and return an error
   `output`; the original file is untouched.

**Rationale**: A crash between (2) and (3) orphans a temp file but leaves the
original intact. A failed temp write never reaches (3), so the original is never
partial. This is the corruption-prevention guarantee the current blind overwrite
lacks. Pi's `write` tool does **not** do this (plain `writeFile`) — seepient-original.

**No `.bak` in v1**: the old content lives in step metadata (for the diff) for
the session. Persistent disk rollback is deferred (spec "Out of scope").

**Codebase precedent**: the temp-file → `rename` pattern is already used by
`SettingsManager` (ARCHITECTURE.md §Settings System: "Atomic persistence: Write
to temp file → rename, with backup"). The safe-write reuses an established
codebase mechanism rather than introducing a new one — consistent with
constitution §II (one atomic-write approach, not two).

**Temp name**: `crypto.randomUUID()` (collision-free, no `Date.now`/`Math.random`
in domain-adjacent code; this is an infrastructure edge effect, acceptable).

## R4 — Size caps + display UX (learned from Pi's `generateDiffString`)

**Decision**:
- `write_file` emits `diffSkipped: true` + `skipReason` in metadata when the new
  content exceeds a cap (**64 KB or 2000 lines**, whichever first). The viewer
  then renders a plain "file written (N lines)" — no giant diff dump.
- The `DiffViewer` borrows Pi's display pattern: padded line numbers, `+`/`-`/` `
  prefix, **context-window collapsing** (~3–4 context lines around each hunk)
  with `... N skipped` elision, and collapses by default with a `... N more`
  expand affordance.

**Rationale**: Pi's `generateDiffString` proves the context-collapse UX reads
well for source. seepient's viewer reuses the idea (not the code).

## R5 — CRLF handling: normalize for comparison

**Decision**: Diff old vs new after normalizing both to LF (Pi's
`normalizeToLF` pattern). Line-ending detection is a display nicety, not a v1
must — normalizing avoids the "every line changed" artifact on CRLF files
without changing what gets written (the new content is written verbatim).

## R6 — Metadata never reaches the LLM

**Decision (invariant)**: The loop pushes `output` only into the `role: 'tool'`
message (`agent-loop.ts`, `messages.push({ content: output })`). Metadata stays
on the `StepResult` and never enters message history. No provider context bloat.

**Backward compat**: tools returning plain strings normalize to
`{ output, success: true }` with no metadata → no diff → unchanged rendering.
Non-write tools are untouched.

## Verified source facts (read during planning)

| Fact | Location | Relevance |
|------|----------|-----------|
| `ToolResult.metadata?` already defined | `src/core/types.ts:97-101` | Channel exists — reuse it |
| `execute` returns `string \| ToolResult` | `src/core/types.ts:88` | Handlers may emit metadata today |
| `ToolModule.handler` typed `Promise<string>` | `src/tools/interface.ts:25` | Must widen to carry metadata |
| `tool()` factory drops `metadata` | `src/core/tool-executor.ts:146-149` | Leak point to fix |
| `executeTool` returns `Promise<string>` | `src/core/tool-executor.ts:188` | Return type to widen |
| `executeTool` has 3 call sites, 1 import | `src/core/agent-loop.ts:413,426,443` | Contained ripple |
| `StepResult` has no metadata slot | `src/core/types.ts:48-64` | Add top-level `metadata?` |
| `WriteFileTool` blind overwrite | `src/tools/core.ts:100-108` | Replace with safe write |
| Pi uses `diff` pkg; `write` not atomic | `pi-coding-agent/dist/core/tools/{write,edit-diff}.js` | Engine choice; our safe-write is additive |
