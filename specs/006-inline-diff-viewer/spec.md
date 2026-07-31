# Spec: Inline Diff Viewer + Safe Write (T051)

**Status**: Planned · **Source**: `docs/todo/deferred-tui-items.md` (T051) · **Date**: 2026-06-17

## Overview

Today the `write_file` tool is a **blind overwrite**: no diff visibility, no
atomicity, no old-content capture. After a write, the tool-call block shows only
"Successfully wrote to <path>" — the user cannot see *what changed*, and a crash
or failure mid-write can corrupt the file.

This feature delivers two tightly-coupled improvements:

1. **Safe write infrastructure** — `write_file` becomes crash-safe (atomic
   temp-file + rename) and captures the old content for diffing.
2. **Inline diff viewer** — the `write_file` tool-call block renders a unified
   diff (green added / red removed / dim context), collapsed by default.

The diff is computed with the [`diff`](https://www.npmjs.com/package/diff) npm
package — the same engine the Pi coding agent uses. The safe-write (atomic +
old-content capture) is seepient-original; Pi's `write` tool is neither atomic nor
diff'd. See `research.md`.

## User Stories

### US1 — Safe atomic write (P1, MVP)

**As a** user, **when** the agent writes a file, **I want** the write to be
atomic and the old content captured, **so that** a crash or failed write never
corrupts my file and the change can be diffed/undone.

**Acceptance**:
- Overwriting an existing file via `write_file` leaves the original intact if
  the write fails (temp file written first, then `fs.rename`; temp cleaned up on
  failure).
- The tool captures the file's previous content and attaches it (plus the new
  content + path) as metadata on the tool step — not in the `output` string the
  LLM sees.
- New files: no old content (`isNewFile: true`), write still atomic.
- The `output` string the LLM receives is unchanged in spirit
  (`Successfully wrote to <path> (N -> M lines)`); only metadata is added.
- Existing tools that return plain strings are unaffected (backward compatible).

### US2 — Inline diff viewer (P1, depends on US1)

**As a** user, **when** the agent calls `write_file`, **I want** the tool-call
block to show a unified diff of the change, **so that** I can review what the
agent changed at a glance.

**Acceptance**:
- After a `write_file`, the tool-call block renders a unified diff: green `+`
  added lines, red `-` removed lines, dim context lines with line numbers.
- New files render all-green; identical rewrites render "no changes".
- Collapsed by default (shows the first changed hunk + a `... N more` indicator);
  expand (Ctrl+O) shows the full diff.
- Large rewrites (over a size/line cap) skip the diff and render a plain
  "file written" note with the size — no multi-thousand-line diff dump.
- CRLF files diff against LF-normalized content so they don't show as
  fully-changed.
- Non-`write_file` tools render exactly as before (no metadata → no diff).

## Out of scope (deferred)

- Persistent `.bak` rollback files (old content lives in step metadata for the
  session; disk rollback is a later enhancement).
- Per-file mutation locking / concurrent-write serialization (the agent loop is
  single-session, sequential; the atomic write covers the real crash risk).
- Diff for the future `edit`/search-replace tool (T051 covers `write_file` only).
