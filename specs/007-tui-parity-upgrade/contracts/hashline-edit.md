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
        description: 'One or more [PATH#TAG] sections. TAG is the 4-hex content hash returned by read_file. Operations: SWAP A.=B:, SWAP.BLK A:, DEL A.=B, DEL.BLK A, INS.PRE A:, INS.POST A:, INS.HEAD:, INS.TAIL:, MV DEST, REM. Body rows prefixed with +.',
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
op           := swap | swap_block | del | del_block | ins | mv | rem
swap         := 'SWAP' WS start '.=' end ':' newline body
swap_block   := 'SWAP.BLK' WS line ':' newline body
del          := 'DEL' WS start '.=' end
del_block    := 'DEL.BLK' WS line
ins          := ('INS.PRE' | 'INS.POST' | 'INS.HEAD' | 'INS.TAIL') [WS line] ':' newline body
mv           := 'MV' WS DEST
rem          := 'REM'
body         := ('+' TEXT? newline)*
```

`TAG` is a 4-hex content hash from the `SnapshotStore`. Line numbers are 1-based. Full grammar in `src/core/hashline/grammar.md` (port of omp's `grammar.lark`).

### 3. `SnapshotStore` (Core)

```ts
// src/core/hashline/snapshot-store.ts
export interface SnapshotStore {
  record(path: string, content: string): string;              // returns tag
  resolve(tag: string): { path: string; content: string } | null;
  verify(tag: string, currentContent: string): boolean;       // hash compare
  snapshot(tag: string): string | null;                       // pre-edit content for merge
  clear(): void;
}
```

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
  if (!store) throw new ToolError('edit_file requires a snapshot store', 'HASHLINE_NO_STORE');

  const patch = parsePatch(args.patch);   // throws HashlineError on malformed grammar
  const results: FileWriteMetadata[] = [];

  for (const section of patch.sections) {
    const resolved = store.resolve(section.tag);
    if (!resolved) throw new HashlineError(`Unknown tag ${section.tag}`, 'HASHLINE_UNKNOWN_TAG', { retryable: false });

    const current = await fs.readFile(resolved.path, 'utf8');
    if (!store.verify(section.tag, current)) {
      // Stale anchor — attempt 3-way merge recovery
      const merged = tryThreeWayMerge(store.snapshot(section.tag)!, current, section);
      if (!merged.ok) throw new HashlineError(`Stale anchor for ${resolved.path}`, 'HASHLINE_STALE_ANCHOR', { retryable: true });
      await atomicWrite(resolved.path, merged.content);
      results.push(metadataFrom(resolved.path, current, merged.content, section.operations));
      continue;
    }
    const next = applyOps(current, section.operations);   // throws on out-of-range lines
    await atomicWrite(resolved.path, next);
    store.record(resolved.path, next);
    results.push(metadataFrom(resolved.path, current, next, section.operations));
  }

  return {
    output: `Edited ${results.length} file(s): ${results.map(r => r.path).join(', ')}`,
    success: true,
    // Single section (common): FileWriteMetadata. ≥2 sections: { edits: FileWriteMetadata[] }.
    metadata: (results.length === 1 ? results[0] : { edits: results }) as EditFileResult,
  };
}
```

`atomicWrite` is the existing 006 helper (temp + `fs.rename`).

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
