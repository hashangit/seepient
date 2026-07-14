# Contract: Hash-Anchored Edit (hashline)

**Phase 1 output.** The contract for the new `edit_file` tool — a hash-anchored line-patch language that replaces whole-file `write_file` for targeted edits. Reuses 006's `FileWriteMetadata` so the existing `DiffViewer` renders the change unchanged.

## Scope

The contract spans:
- **Core** (`src/core/hashline/`) — the patcher, `SnapshotStore`, grammar, parser. Adapter-agnostic.
- **Tools** (`src/tools/`) — `edit_file` tool module; `read_file`/`write_file` extended to record into the `SnapshotStore`.
- **TUI** — no change. The existing `DiffViewer` (006) renders the diff because `edit_file` emits the same `FileWriteMetadata` shape.

Inspired by omp's `@oh-my-pi/hashline` (`packages/hashline/`). Sealed at the tool boundary: the LLM emits a patch string; the patcher validates, applies, and returns metadata.

## Contract

### 1. Tool registration

```ts
{
  name: 'edit_file',
  description: 'Apply a hash-anchored line patch to one or more files. Prefer this over write_file for targeted edits to existing files — smaller payload, fewer reproduction errors. Use write_file only for new files or full rewrites.',
  parameters: {
    type: 'object',
    required: ['patch'],
    properties: {
      patch: {
        type: 'string',
        description: 'One or more [PATH#TAG] sections. TAG is the 4-hex content hash returned by read_file. Operations: SWAP A.=B:, SWAP.BLK A:, DEL A.=B, DEL.BLK A, INS.PRE A:, INS.POST A:, INS.HEAD:, INS.TAIL:. Body rows prefixed with +. Order multiple operations from bottom-to-top (highest line first) so line numbers stay correct.',
      },
    },
  },
  risk: 'edit',
}
```

Risk category `edit` (same as `write_file`) — permission matrix (`permission.ts`) treats it identically.

### 2. Patch format (grammar summary)

```
file-section := '[' PATH '#' TAG ']' newline (op newline)*
op           := swap | swap_block | del | del_block | ins
swap         := 'SWAP' WS start '.=' end ':' newline body
swap_block   := 'SWAP.BLK' WS line ':' newline body
del          := 'DEL' WS start '.=' end
del_block    := 'DEL.BLK' WS line
ins          := ('INS.PRE' | 'INS.POST' | 'INS.HEAD' | 'INS.TAIL') [WS line] ':' newline body
body         := ('+' TEXT? newline)*
```

`TAG` is a 4-hex content hash, path-scoped (different files with identical content get different tags). Line numbers are 1-based.

### 3. `SnapshotStore` (Core)

Path-keyed content registry — one snapshot per path (the latest recorded
content). Resolution is by path, then the stored tag is compared against the
section's tag. Path-scoping (the tag hashes `path + NUL + content`) ensures
different files with identical content never collide.

```ts
// src/core/hashline/snapshot-store.ts
export interface SnapshotStore {
  /** Record a snapshot and return its 4-hex tag. Empty string if oversized (>1MB). */
  record(path: string, content: string): string;
  /** Path-keyed resolution — returns the stored tag + content for this path. */
  resolvePath(path: string): { tag: string; content: string } | null;
  /** Return the raw pre-edit content for a path (for stale-anchor reapply). */
  snapshot(path: string): string | null;
  clear(): void;
}
```

**Design note (diverges from the original tag-keyed draft):** the store holds
one entry per path, keyed by path, not by tag. Rationale: the tag is a *version
stamp* verified on lookup, not a lookup key — this avoids any cross-path
collision risk and keeps the store O(paths) rather than O(versions). The
trade-off is that only the latest snapshot per path is retained, so the
stale-anchor reapply (§5) operates on the latest recorded content for the path,
not the content corresponding to the model's specific tag. This is acceptable
because a stale tag is the signal to re-read; the reapply is a best-effort
fast path, not a guaranteed merge.

One store per CLI session (`src/adapters/cli/bootstrap.ts` creates it; passed to tools via the tool-executor config). Not persisted — rebuilt lazily as files are read.

### 4. Producer side — `read_file` / `write_file` record

```ts
// read_file handler (existing) — additive:
const content = await fs.readFile(path, 'utf8');
config.snapshotStore?.record(path, content);   // NEW — optional chaining, no-op if absent
return content;

// write_file handler (existing, post 006) — additive:
await atomicWrite(path, newContent);
config.snapshotStore?.record(path, newContent); // NEW
return { output, success, metadata: { ...FileWriteMetadata } };
```

Backward compatible: `snapshotStore` is optional on the tool config. SDK/Server calls that don't provide one skip recording (their `edit_file` calls would then fail with `HASHLINE_UNKNOWN_TAG` — acceptable, since SDK/Server adoption is a future spec).

### 5. Consumer side — `edit_file` handler

```ts
handler: async (args, config) => {
  const store = config.snapshotStore;
  if (!store) throw new HashlineError('edit_file requires a snapshot store', 'HASHLINE_NO_STORE', false);

  const patch = parsePatch(args.patch);   // throws HashlineError on malformed grammar
  const results: FileWriteMetadata[] = [];

  for (const section of patch.sections) {
    const { path: filePath, tag } = section;
    const resolved = store.resolvePath(filePath);          // path-keyed lookup
    if (!resolved) throw new HashlineError(`No snapshot for path: ${filePath}`, 'HASHLINE_UNKNOWN_TAG', false);

    // Tag mismatch vs. the model's section tag → the model used a tag from a
    // different version of this path (stale). Before rejecting, reapply ops to
    // the snapshot and accept only if the result exactly matches current content.
    if (resolved.tag !== tag) {
      throw new HashlineError(`Stale tag for ${filePath} — file changed since snapshot`, 'HASHLINE_STALE_ANCHOR', true);
    }

    const current = await fs.readFile(filePath, 'utf8');
    const currentTag = tagFor(filePath, current);
    if (currentTag !== resolved.tag) {
      // File changed on disk since the snapshot was recorded (external edit, or a
      // prior edit_file in this session updated the store). Best-effort reapply:
      // apply ops to the snapshot, accept only if the result matches current.
      const snapshotContent = store.snapshot(filePath);
      if (!snapshotContent) throw new HashlineError(`Stale anchor for ${filePath} (no snapshot)`, 'HASHLINE_STALE_ANCHOR', true);
      const merged = tryReapplyOrReject(snapshotContent, current, section.operations);
      if (!merged.ok) throw new HashlineError(`Stale anchor for ${filePath} — file changed since snapshot`, 'HASHLINE_STALE_ANCHOR', true);
      await atomicWrite(filePath, merged.content!);
      store.record(filePath, merged.content!);
      results.push(metadataFrom(filePath, current, merged.content!, section.operations));
      continue;
    }

    // Fresh anchor: apply ops bottom-to-top so line numbers stay correct.
    const next = applyOps(current, sortOpsBottomToTop(section.operations));
    await atomicWrite(filePath, next);
    store.record(filePath, next);
    results.push(metadataFrom(filePath, current, next, section.operations));
  }

  return {
    output: `Edited ${results.length} file(s): ${results.map(r => r.path).join(', ')}`,
    success: true,
    // Single section (common): FileWriteMetadata. ≥2 sections: { edits: FileWriteMetadata[] }.
    metadata: (results.length === 1 ? results[0] : { edits: results }) as EditFileResult,
  };
}
```

`atomicWrite` is the existing 006 helper (temp + `fs.rename`). `sortOpsBottomToTop` orders operations by descending anchor line so sequential application doesn't shift line numbers of ops earlier in the file.

### 6. Metadata shape — reuses `FileWriteMetadata`

**Threshold (determines union branch)**: a patch with exactly 1 section → `FileWriteMetadata` (the common case; `DiffViewer` works unchanged). A patch with ≥2 sections → `{ edits: FileWriteMetadata[] }` (the TUI renders each as a separate diff block).

```ts
// Single section (common): metadata IS FileWriteMetadata — DiffViewer unchanged.
metadata: { path, oldContent, newContent, isNewFile: false, byteDelta, editSource: 'hashline' } satisfies FileWriteMetadata

// ≥2 sections: metadata is { edits: FileWriteMetadata[] } — TUI renders N blocks.
metadata: { edits: FileWriteMetadata[] }
```

`isFileWriteMetadata` (006 guard) still passes for the single-file case. For multi-file, a new `isMultiFileEditResult` guard handles `{ edits: FileWriteMetadata[] }`. Both render through the existing `DiffViewer`. The union type `EditFileResult = FileWriteMetadata | { edits: FileWriteMetadata[] }` is defined once in `data-model.md §7`.

### 7. Streaming diff stabilization (R9)

When `edit_file` is called during a streaming turn, the patch is applied incrementally. Before the step commits to `<Static>`, `stripTrailingUnbalancedRemoval(diff)` (port of omp's utility) trims trailing `-old`/`@@hunk` lines that haven't yet got their matching `+new` lines. Prevents the "removals first, additions catching up" jitter.

This is a T2/T3 utility applied at the ChatBlock commit gate (see `feed-lifecycle.md`).

## Error codes (extend `src/core/errors.ts`)

| Code | When | retryable |
|---|---|---|
| `HASHLINE_NO_STORE` | tool called without a snapshot store in config | false |
| `HASHLINE_UNKNOWN_TAG` | tag not in store (file never read this session) | false |
| `HASHLINE_STALE_ANCHOR` | tag's recorded hash ≠ live file hash | true (agent should re-read + re-patch) |
| `HASHLINE_PARSE_ERROR` | malformed patch grammar | true |
| `HASHLINE_OUT_OF_RANGE` | line number outside file bounds | true |

All extend `SeepientError` with `code` + `retryable` (existing convention).

## Backward compatibility

| Producer | TUI renders |
|---|---|
| `write_file` (whole-file, retained) | existing `DiffViewer` (006, unchanged) |
| `edit_file` single-file | existing `DiffViewer` (same metadata shape) |
| `edit_file` multi-file | N `DiffViewer` blocks (new rendering path, additive) |
| `read_file` | unchanged return value; additively records into store |

`write_file` is **not** deprecated — it remains the correct tool for new files and full rewrites. `edit_file` is the preferred tool for targeted edits to existing files.

## Non-goals

- **Cross-session tag persistence** — store is session-scoped (rebuilt on read). omp matches this.
- **Custom Filesystem backends** (omp's `Filesystem` abstraction) — v1 uses `NodeFilesystem` only. The abstraction is added when SDK/Server adopt.
- **`SWAP.BLK` scope in v1** — the grammar includes `SWAP.BLK` and the parser accepts it, but v1's block resolution is **indentation-based only** (a "block" = contiguous lines at the same non-decreasing indentation level under `startLine`). Full AST-anchored blocks (LSP-backed, language-aware) are **deferred** to a future spec. `DEL.BLK` mirrors this.
- **Streaming patch application** (apply-as-it-arrives) — v1 applies the complete patch on tool-call completion. omp's streaming preview is a future enhancement.
