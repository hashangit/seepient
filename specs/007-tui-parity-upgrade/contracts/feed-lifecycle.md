# Contract: ChatBlock / Feed Lifecycle

**Phase 1 output.** The internal boundary contract for lifecycle-aware feed blocks — the keystone primitive (T4-1) that gates T1 widgets, T4-3 thinking indicator, and live tool blocks. Extends the existing `FeedEntry` union and `useFeed` API without breaking the 003/006 `<Static>` model.

## Scope

The contract covers:
- **`BlockEntry`** — new discriminated member of `FeedEntry` (`types.ts`).
- **`ChatBlockInstance`** — the lifecycle handle (port of omp's `chat-block.ts`, adapted to React/Ink).
- **`useFeed` extension** — new `mountBlock`/`updateBlock`/`finalizeBlock`/`disposeBlock` API.
- **`<MessageArea>` rendering rule** — unfinalized blocks in the live region; finalized in `<Static>` history.

This is the in-process TUI contract. No cross-adapter boundary.

## Contract

### 1. `BlockEntry` (new feed kind)

Extends `FeedEntry` (`types.ts:55`):

```ts
export interface BlockEntry {
  id: string;
  kind: 'block';
  blockKind: 'widget' | 'thinking' | 'live-tool' | 'custom';
  props: unknown;          // opaque at feed level; parsed by blockKind renderer
  finalized: boolean;      // false while updatable; true once frozen
}
```

`FeedEntry` union gains `| BlockEntry`. Existing kinds (`user`, `assistant`, `tool`, `error`, `info`, `logo`) unchanged.

**Invariants**:
- `finalized:true` ⇒ entry is immutable (matches `<Static>` freeze).
- `blockKind` controls which React renderer `<MessageArea>` dispatches to.
- `props` is `unknown` at the feed level; each renderer parses it defensively at the boundary (parse, don't validate — `file-write-meta.ts` precedent).

### 2. `ChatBlockInstance` — lifecycle handle

```ts
// new file: src/adapters/cli/tui/chat-block.ts
export interface ChatBlockInstance {
  readonly id: string;             // matches the BlockEntry id
  readonly blockKind: BlockEntry['blockKind'];
  readonly isActive: boolean;      // false after finalize/dispose
  update(props: unknown): void;    // no-op after finalize; patches BlockEntry.props
  finalize(): void;                // freeze: finalized=true, run cleanups once
  dispose(): void;                 // freeze + run cleanups once
  onCleanup(fn: () => void): void; // register teardown (à la useEffect cleanup)
}
```

**Invariants**:
- `finalize` and `dispose` each run cleanups exactly once; idempotent.
- After `finalize`, `update` is a no-op (defensive — drops the patch silently).
- After `dispose`, the `BlockEntry` is frozen (finalized:true). Since dispose is only called on unmount (feed state is discarded), removal from feed.entries is unnecessary — the frozen entry degrades gracefully if ever persisted and replayed.
- A block that is neither finalized nor disposed has `isActive:true`.

### 3. `ChatBlockHost` — `createChatBlock` factory

```ts
// chat-block.ts (implementation)
export function createChatBlock(
  feed: FeedApi,
  blockKind: BlockEntry['blockKind'],
  initialProps: unknown,
): ChatBlockInstance;
```

`createChatBlock` appends a `BlockEntry` with `finalized:false` via `feed.appendEntry({kind:'block',...})` and returns a `ChatBlockInstance` bound to that id. The instance methods call `feed.updateBlockEntry(id, patch)` for update/finalize/dispose — the lifecycle lives on the instance, not on the feed.

The feed exposes a single block-aware method:

```ts
// use-feed.ts (actual surface)
export interface FeedApi {
  entries: FeedEntry[];
  appendEntry: (entry: FeedEntryInput) => string;
  updateEntry: (id: string, patch: Partial<FeedEntry>) => void;
  clear: () => void;
  /** Patch a block entry's props and/or finalized flag. */
  updateBlockEntry: (id: string, patch: Partial<BlockEntry>) => void;
}
```

(NOTE: The initial contract specified `mountBlock`/`updateBlock`/`finalizeBlock`/`disposeBlock` on `FeedApi`, but the implementation moved lifecycle ownership to `ChatBlockInstance`. The contract has been updated to match.)

### 4. `<MessageArea>` rendering rule

`<MessageArea>` already splits entries between `<Static>` (frozen) and the live region. The rule extends cleanly:

| Entry state | Rendered in | Re-renders? |
|---|---|---|
| Any non-block entry (user, assistant, tool, …) | `<Static>` (after completion) | no (frozen) |
| `BlockEntry` with `finalized:true` | `<Static>` | no (frozen) |
| `BlockEntry` with `finalized:false` | live region (outside `<Static>`) | yes (re-renders on `updateBlock`) |

Concretely: `<MessageArea>` partitions `feed.entries` into `staticEntries = entries.filter(e => !(isBlock(e) && !e.finalized))` and `liveBlocks = entries.filter(e => isBlock(e) && !e.finalized)`. `<Static>` renders `staticEntries`; the live region renders `liveBlocks` after the streaming text/tool slots.

The existing `staticKey` remount machinery (resize / expand / session-resume) handles the `<Static>` repopulation; no new mechanism.

### 5. Renderer dispatch

```tsx
function BlockRenderer({ entry }: { entry: BlockEntry }) {
  switch (entry.blockKind) {
    case 'widget':    return <WidgetBlock spec={parseWidgetSpec(entry.props)} finalized={entry.finalized} />;
    case 'thinking':  return <ThinkingBlock {...parseThinkingProps(entry.props)} />;
    case 'live-tool': return <LiveToolBlock {...parseLiveToolProps(entry.props)} />;
    case 'custom':    return <CustomBlock {...entry.props as CustomBlockProps} />;
  }
}
```

Each parser is a defensive type guard returning the narrow type or a fallback (never throws — a malformed block renders an error block, not a crash).

### 6. Stream → block → freeze (typical widget flow)

```
1. LLM calls render_widget → tool handler validates → ToolResult.metadata.spec
2. use-agent onStep sees render_widget → widgetHost.mount(spec)
   → feed.mountBlock('widget', spec) → returns ChatBlockInstance
   → BlockEntry appended with finalized:false
3. <MessageArea> renders the block in the live region (re-renders on update)
4. User activates an action → WidgetActionDispatch → submit(synthetic)
   → for one-shot widgets: block.finalize() → finalized:true → moves to <Static>
   → for multi-action widgets: stays live until turn ends
5. On turn end / agent abort: any still-live block finalizes (defensive — no orphan animators)
6. On session resume: feed-serializer rebuilds blocks from persisted render_widget
   tool messages as finalized:true, non-interactive
```

### 7. Cleanup guarantee

A `ChatBlockInstance` may register cleanups (timers, subscriptions) via `onCleanup`. The host guarantees:
- `finalize()` runs cleanups (the block's final frame stays in history).
- `dispose()` runs cleanups AND removes the entry (used on transcript reset / session switch).
- On TUI teardown (`index.tsx` unmount), all live blocks are disposed. No orphan timers.

This is the React-equivalent of omp's `onMount`/`onCleanup` discipline, enforced at the host level so a buggy block can't leak.

## Backward compatibility

| Caller | Behavior |
|---|---|
| Existing `appendEntry({kind:'tool', ...})` | unchanged |
| Existing `appendEntry({kind:'assistant', ...})` (streaming commit) | unchanged |
| New `mountBlock('widget', spec)` | adds a `BlockEntry`; existing renders unaffected |
| `<MessageArea>` without any blocks | `liveBlocks` is `[]`; behaves identically to today |
| Session resume without persisted widget calls | no blocks; existing feed-serializer behavior |

## Non-goals

- **Arbitrary nesting of live blocks** — v1 supports flat live-region blocks. Nested layouts are L2 (deferred).
- **Cross-block focus chains** — each interactive block owns its focus; Tab cycles within. Inter-block Tab order is a later enhancement.
- **Persistence of unfinalized blocks** — only finalized blocks round-trip through `SessionData` (re-derived on resume). Unfinalized blocks are dropped on resume (transient by nature).
