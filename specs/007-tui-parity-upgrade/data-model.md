# Data Model: TUI Parity & Generative Widget Upgrade

**Phase 1 output.** Entities, fields, relationships, validation, and state transitions for the spec. Every type extends or composes with an existing Seepient type (verified against source: `src/adapters/cli/tui/types.ts`, `hooks/use-feed.ts`, `diff/file-write-meta.ts`, `src/core/types.ts`).

## Entity index

| Entity | Layer | New? | Source |
|---|---|---|---|
| `BlockEntry` (feed kind) | TUI | yes | extends `FeedEntry` union |
| `ChatBlock` | TUI | yes | new lifecycle primitive |
| `WidgetSpec` | Tool/TUI contract | yes | `render_widget` tool payload |
| `WidgetAction` | Tool/TUI contract | yes | round-trip message |
| `WidgetActionDispatch` | TUI/agent boundary | yes | synthetic user message |
| `HashlinePatch` | Tool contract | yes | `edit_file` tool payload |
| `SnapshotStore` | Core (Infrastructure-shared) | yes | file-content hash registry |
| `EditFileResult` | Tool/TUI contract | yes | discriminated union over 006's `FileWriteMetadata` (single-file) or `{edits:[]}` (multi-file) |

---

## 1. `BlockEntry` — new feed kind

Extends the existing `FeedEntry` discriminated union (`types.ts:55`). A block is a lifecycle-managed feed entry: it renders into a React element, can update while unfinalized, and freezes on `finalize`.

```ts
// Added to types.ts
export interface BlockEntry {
  id: string;
  kind: 'block';
  /** Discriminator for the React renderer (maps to a ChatBlock subtype). */
  blockKind: 'widget' | 'thinking' | 'live-tool' | 'custom';
  /** Opaque payload — parsed by the blockKind-specific renderer. */
  props: unknown;
  /** false while the block may still update; true once frozen into history. */
  finalized: boolean;
}
```

**Validation**: `blockKind ∈ {'widget','thinking','live-tool','custom'}`; `props` is opaque at the feed level (parsed at the renderer boundary by a type guard).

**State transitions**:
```
mounted (finalized:false) ──updateBlock──► mounted (finalized:false, new props)
                       └──finalizeBlock──► finalized (finalized:true)
                       └──disposeBlock───► removed from feed
```

Once `finalized:true`, the entry is immutable (matches `<Static>`'s freeze semantics). On session resume, `feed-serializer.ts` rebuilds finalized blocks only; unfinalized blocks are dropped (they were transient).

## 2. `ChatBlock` — lifecycle primitive

The React-side abstraction over a `BlockEntry`. Not a feed entry itself; it *produces* and *owns* one. Modeled on omp's `chat-block.ts` (R7), adapted to React/Ink.

```ts
// new file: src/adapters/cli/tui/chat-block.ts
export interface ChatBlockInstance {
  readonly id: string;
  readonly blockKind: BlockEntry['blockKind'];
  /** True between mount and finalize/dispose. */
  isActive: boolean;
  /** Patch props (re-renders the block). No-op after finalize. */
  update(props: unknown): void;
  /** Self-complete: freeze the final frame into history. */
  finalize(): void;
  /** Host discard: remove from feed, run cleanups. */
  dispose(): void;
  /** Register a teardown à la useEffect cleanup. Runs once on finalize/dispose. */
  onCleanup(fn: () => void): void;
}

export interface ChatBlockHost {
  /** Provided to blocks so they can manage their own feed entry. */
  mount(blockKind: BlockEntry['blockKind'], initialProps: unknown): ChatBlockInstance;
  requestRender(): void;
}
```

**Relationship**: `ChatBlockHost` is implemented by `useFeed` (extended). Each `ChatBlockInstance` owns exactly one `BlockEntry` in the feed array.

**Invariants**:
- `finalize` and `dispose` each run cleanups exactly once; calling both is safe (second is a no-op).
- After `finalize`, `update` is a no-op (defensive).
- `dispose` removes the entry from the feed (used on transcript reset / session switch).

## 3. `WidgetSpec` — `render_widget` tool payload

The declarative L1 widget descriptor the LLM emits. Validated at the tool boundary (parse, don't validate — `errors.ts` precedent).

```ts
// new file: src/tools/widgets.ts (tool) + src/adapters/cli/tui/widgets/types.ts (TUI)
export type WidgetKind =
  | 'table' | 'keyvalue' | 'chart' | 'tree' | 'panel'
  | 'diff' | 'form' | 'product_card' | 'status_grid';

export interface WidgetAction {
  id: string;        // opaque; round-tripped unchanged
  label: string;
  style?: 'primary' | 'secondary' | 'danger';
}

export interface WidgetSpec {
  /** Client-generated id so multiple widgets can coexist. */
  id: string;
  kind: WidgetKind;
  title?: string;
  /** kind-specific props; validated against the kind's schema. */
  props: Record<string, unknown>;
  /** If present, the widget stays in the live region and emits WidgetAction. */
  actions?: WidgetAction[];
}
```

**Validation** (at tool boundary, before TUI sees it):
- `kind` ∈ enum; else `WidgetError` (`code: WIDGET_INVALID_KIND`).
- `props` matches the kind's schema (e.g. `table` requires `columns: string[]`, `rows: unknown[][]`); else `WIDGET_INVALID_PROPS`.
- `actions[].id` unique within the widget; else `WIDGET_DUPLICATE_ACTION`.
- `id` non-empty; `title` (if present) ≤ 200 chars.

**Kind-specific prop schemas** (in `contracts/widget-protocol.md`):
- `table`: `{columns: string[], rows: unknown[][]}`
- `keyvalue`: `{entries: {label, value}[]}`
- `chart`: `{variant: 'bar'|'line'|'sparkline', data: number[], labels?: string[]}`
- `tree`: `{root: {label: string, children?: TreeNode[]}}`
- `panel`: `{body: string | string[], accent?: string}`
- `diff`: `{oldContent: string|null, newContent: string, path?: string}`
- `form`: `{fields: {id, label, type:'text'|'number'|'boolean'|'select', placeholder?, options?}[], submitLabel?}`
- `product_card`: `{title, subtitle?, price?, rating?, imageRef?, actions: WidgetAction[]}`
- `status_grid`: `{items: {label, status:'ok'|'warn'|'fail'|'pending'}[]}`

## 4. `WidgetAction` → `WidgetActionDispatch` — the round-trip

When the user activates a widget element, the TUI produces a structured dispatch that becomes a new agent turn.

```ts
// TUI → agent-loop boundary
export interface WidgetActionDispatch {
  widgetId: string;
  actionId: string;
  /** For form widgets: the field values. For others: undefined. */
  state?: Record<string, unknown>;
  /** ISO timestamp for the synthetic message. */
  timestamp: string;
}
```

**Serialized form** (the synthetic user message the agent sees):
```
[widget:<widgetId>] action "<actionId>" state { ... }
```

The agent loop treats this as a normal user message. No special tooling on the agent side — the model reads it and decides what to do.

**Safety property**: the LLM never receives execution capability. It proposed `{actionId}` labels; the harness attaches meaning by re-feeding them as text.

## 5. `HashlinePatch` — `edit_file` tool payload

The patch string the LLM emits for hash-anchored edits.

```ts
// new file: src/core/hashline/types.ts
export interface HashlinePatch {
  /** Raw patch text: one or more [PATH#TAG] sections with operations. */
  source: string;
  /** Which snapshot store to resolve tags against. */
  storeId: string;
}

export interface HashlineSection {
  path: string;
  tag: string;          // 4-hex content hash from SnapshotStore
  operations: HashlineOp[];
}

export type HashlineOp =
  | { type: 'swap'; startLine: number; endLine: number; body: string[] }
  | { type: 'swap_block'; startLine: number; body: string[] }
  | { type: 'del'; startLine: number; endLine: number }
  | { type: 'del_block'; startLine: number }
  | { type: 'ins_pre' | 'ins_post' | 'ins_head' | 'ins_tail'; line?: number; body: string[] }
  | { type: 'mv'; dest: string }
  | { type: 'rem' };
```

**Validation** (at parse boundary):
- Grammar conforms to `src/core/hashline/grammar` (port omp's lark grammar or hand-roll).
- Every `[PATH#TAG]` resolves in the `SnapshotStore`; else `HashlineError` (`code: HASHLINE_UNKNOWN_TAG`, retryable: false).
- On apply: live-file hash must match recorded hash; else `HASHLINE_STALE_ANCHOR` (retryable: true — agent should re-read and re-patch).

## 6. `SnapshotStore` — file-content hash registry

```ts
// new file: src/core/hashline/snapshot-store.ts
export interface SnapshotStore {
  /** Record a file's content hash; returns the tag (4-hex). */
  record(path: string, content: string): string;
  /** Resolve a tag back to a path + verify current content matches. */
  resolve(tag: string, currentContent: string): { path: string; match: boolean };
  /** Snapshot for 3-way merge recovery. */
  snapshot(path: string): string | null;
  clear(): void;
}
```

**Lifecycle**: one `SnapshotStore` per CLI session. `read_file`, `write_file`, and `edit_file` record into it whenever they observe file content. Tags are scoped to the session (not persisted — matches omp).

**Relationship to existing tools**:
- `read_file` extended: after reading, call `store.record(path, content)`. No change to its return value.
- `write_file` extended: after writing, call `store.record(path, newContent)`.
- `edit_file` (new): reads from `store` to verify; writes via atomic rename (per 006); records new content.

## 7. `EditFileResult` — discriminated union over `FileWriteMetadata`

The existing 006 contract (`diff/file-write-meta.ts`) passes `FileWriteMetadata` from `write_file` → `StepResult.metadata` → `DiffViewer`. The new `edit_file` reuses `FileWriteMetadata` so `DiffViewer` works unchanged. A single name, `EditFileResult`, covers both single-file and multi-file cases:

```ts
// new type alias in src/tools/edit-file.ts (re-exports FileWriteMetadata from core.ts)
import type { FileWriteMetadata } from './core.js';

/** Single section → FileWriteMetadata (the common case; DiffViewer unchanged).
 *  ≥2 sections → { edits: FileWriteMetadata[] } (TUI renders N diff blocks). */
export type EditFileResult = FileWriteMetadata | { edits: FileWriteMetadata[] };

// edit_file handler returns:
{
  output: `Edited ${results.length} file(s): ${results.map(r => r.path).join(', ')}`,
  success: true,
  metadata: singleSection
    ? ({ path, oldContent, newContent, isNewFile: false, byteDelta, editSource: 'hashline' } satisfies FileWriteMetadata)
    : ({ edits: results } satisfies { edits: FileWriteMetadata[] }),
} satisfies { output: string; success: boolean; metadata: EditFileResult }
```

**Threshold**: single patch section → `FileWriteMetadata` (the first union member). ≥2 sections → `{ edits: FileWriteMetadata[] }` (the second). The TUI selects the render path with a discriminative type guard on the presence of `edits`.

**Backward compatibility**: `FileWriteMetadata` is unchanged (`editSource` is additive and optional). `isFileWriteMetadata` guard (006) still passes for the single-file case. A new `isMultiFileEditResult` guard handles `{ edits: [] }`. `DiffViewer` renders either path without knowing the edit came from hashline.

---

## State summary — what changes per layer

| Layer | New types | Extended existing | Unchanged |
|---|---|---|---|
| TUI (`tui/`) | `BlockEntry`, `ChatBlock`, widget renderers | `FeedEntry` union (+block), `useFeed` API | `AssistantMessage`, `ToolCallBlock`, `DiffViewer` |
| Tools (`tools/`) | `render_widget` tool module, widget schema validators | — | `write_file` (retained as fallback), `read_file` (+record) |
| Core (`core/`) | `hashline/` module, `SnapshotStore`, `HashlinePatch` | — | `agent-loop`, `tool-executor`, providers |
| Agent boundary | `WidgetActionDispatch` (synthetic message format) | — | message types |

## Non-persistence (v1)

- `BlockEntry` (unfinalized) is **not** serialized into `SessionData`. Resume drops live blocks.
- Finalized blocks are re-derived from persisted messages by `feed-serializer.ts` (widget tool calls round-tripped as their `WidgetSpec` → rendered on resume as finalized, non-interactive).
- `SnapshotStore` is **session-scoped**, not persisted. Resume rebuilds it lazily as files are read.

These match omp's behavior and keep v1 simple. Persistence is a future spec.
