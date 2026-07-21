/**
 * T4-1 — ChatBlock lifecycle primitive.
 *
 * Port of omp's chat-block.ts (111 lines), adapted to React/Ink. A ChatBlock
 * owns one BlockEntry in the feed: it can update while unfinalized, freezes on
 * finalize, and gets disposed on transcript reset.
 *
 * See `contracts/feed-lifecycle.md`.
 */

import type { BlockEntry } from './types.js';
import type { FeedApi } from './hooks/use-feed.js';

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
  mount(blockKind: BlockEntry['blockKind'], initialProps: unknown): ChatBlockInstance;
}

/** Create a ChatBlockInstance backed by a FeedApi. The block owns its BlockEntry. */
export function createChatBlock(
  feed: FeedApi,
  blockKind: BlockEntry['blockKind'],
  initialProps: unknown,
): ChatBlockInstance {
  let active = true;
  let finalized = false;
  const cleanups: Array<() => void> = [];
  let cleanupRan = false;

  const entryId = feed.appendEntry({
    kind: 'block',
    blockKind,
    props: initialProps,
    finalized: false,
  });

  const runCleanups = (): void => {
    if (cleanupRan) return;
    cleanupRan = true;
    for (const fn of cleanups) {
      try { fn(); } catch { /* cleanup must not throw */ }
    }
  };

  const instance: ChatBlockInstance = {
    id: entryId,
    blockKind,
    get isActive() { return active; },
    update(props: unknown): void {
      if (finalized) return; // no-op after finalize
      feed.updateBlockEntry(entryId, { props });
    },
    finalize(): void {
      if (finalized || !active) return;
      finalized = true;
      active = false;
      runCleanups();
      feed.updateBlockEntry(entryId, { finalized: true });
    },
    dispose(): void {
      if (!active) return;
      active = false;
      runCleanups();
      if (!finalized) {
        feed.updateBlockEntry(entryId, { finalized: true });
      }
    },
    onCleanup(fn: () => void): void {
      cleanups.push(fn);
    },
  };

  return instance;
}
