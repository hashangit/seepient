/**
 * T4-1e — ChatBlock lifecycle tests.
 *
 * Exercises the invariants in contracts/feed-lifecycle.md §2:
 *   - finalize/dispose are idempotent (run cleanups exactly once)
 *   - update is a no-op after finalize
 *   - isActive is true between mount and finalize/dispose
 *   - onCleanup cleanups run once on finalize OR dispose (not both)
 *   - dispose after finalize does not double-run cleanups
 *
 * Uses a non-React FeedApi stub (same interface as use-feed) so no Ink/React
 * rendering is required.
 */
import { describe, it, expect } from 'vitest';
import { createChatBlock } from '../chat-block.js';
import { generateId } from '../../../../core/message-convert.js';
import type { FeedApi, FeedEntry, FeedEntryInput, BlockEntry } from '../types.js';

/** Non-React feed for testing — same FeedApi interface as use-feed.ts. */
function createTestFeed(): FeedApi {
  let entries: FeedEntry[] = [];
  return {
    get entries() { return entries; },
    appendEntry(input: FeedEntryInput): string {
      const id = generateId();
      entries = [...entries, { ...input, id } as FeedEntry];
      return id;
    },
    updateEntry(id: string, patch: Partial<FeedEntry>): void {
      entries = entries.map((e) => (e.id === id ? ({ ...e, ...patch } as FeedEntry) : e));
    },
    clear(): void { entries = []; },
    updateBlockEntry(id: string, patch: Partial<BlockEntry>): void {
      entries = entries.map((e) => (e.id === id ? ({ ...e, ...patch } as FeedEntry) : e));
    },
  };
}

describe('ChatBlock lifecycle', () => {
  it('mounts with isActive=true and appends an unfinalized BlockEntry', () => {
    const feed = createTestFeed();
    const block = createChatBlock(feed, 'widget', { kind: 'table' });

    expect(block.isActive).toBe(true);
    expect(block.blockKind).toBe('widget');
    expect(feed.entries).toHaveLength(1);
    const entry = feed.entries[0];
    expect(entry.kind).toBe('block');
    if (entry.kind === 'block') {
      expect(entry.finalized).toBe(false);
      expect(entry.props).toEqual({ kind: 'table' });
    }
  });

  it('update patches props while active', () => {
    const feed = createTestFeed();
    const block = createChatBlock(feed, 'widget', { kind: 'table' });

    block.update({ kind: 'table', rows: 5 });
    const entry = feed.entries[0];
    if (entry.kind === 'block') {
      expect(entry.props).toEqual({ kind: 'table', rows: 5 });
    }
  });

  it('finalize freezes the block: finalized=true, isActive=false', () => {
    const feed = createTestFeed();
    const block = createChatBlock(feed, 'widget', {});

    block.finalize();
    expect(block.isActive).toBe(false);
    const entry = feed.entries[0];
    if (entry.kind === 'block') expect(entry.finalized).toBe(true);
  });

  it('update is a no-op after finalize', () => {
    const feed = createTestFeed();
    const block = createChatBlock(feed, 'widget', { v: 1 });

    block.finalize();
    block.update({ v: 2 }); // must be dropped silently

    const entry = feed.entries[0];
    if (entry.kind === 'block') {
      expect(entry.props).toEqual({ v: 1 }); // unchanged
      expect(entry.finalized).toBe(true);
    }
  });

  it('finalize is idempotent — cleanups run exactly once', () => {
    const feed = createTestFeed();
    const block = createChatBlock(feed, 'widget', {});
    let cleanupCount = 0;
    block.onCleanup(() => { cleanupCount++; });

    block.finalize();
    block.finalize(); // second call must be a no-op
    block.finalize();

    expect(cleanupCount).toBe(1);
    expect(block.isActive).toBe(false);
  });

  it('dispose runs cleanups exactly once and freezes the entry', () => {
    const feed = createTestFeed();
    const block = createChatBlock(feed, 'widget', {});
    let cleanupCount = 0;
    block.onCleanup(() => { cleanupCount++; });

    block.dispose();
    expect(cleanupCount).toBe(1);
    expect(block.isActive).toBe(false);
    const entry = feed.entries[0];
    if (entry.kind === 'block') expect(entry.finalized).toBe(true);
  });

  it('dispose is idempotent', () => {
    const feed = createTestFeed();
    const block = createChatBlock(feed, 'widget', {});
    let cleanupCount = 0;
    block.onCleanup(() => { cleanupCount++; });

    block.dispose();
    block.dispose();
    block.dispose();

    expect(cleanupCount).toBe(1);
  });

  it('dispose after finalize does not re-run cleanups', () => {
    const feed = createTestFeed();
    const block = createChatBlock(feed, 'widget', {});
    let cleanupCount = 0;
    block.onCleanup(() => { cleanupCount++; });

    block.finalize();
    block.dispose(); // dispose must not run cleanups again

    expect(cleanupCount).toBe(1);
  });

  it('multiple cleanups each run once on finalize', () => {
    const feed = createTestFeed();
    const block = createChatBlock(feed, 'widget', {});
    const calls: string[] = [];
    block.onCleanup(() => { calls.push('a'); });
    block.onCleanup(() => { calls.push('b'); });
    block.onCleanup(() => { calls.push('c'); });

    block.finalize();
    expect(calls).toEqual(['a', 'b', 'c']);

    // A second finalize must not re-run any.
    block.finalize();
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('cleanup that throws does not prevent subsequent cleanups', () => {
    const feed = createTestFeed();
    const block = createChatBlock(feed, 'widget', {});
    const calls: string[] = [];
    block.onCleanup(() => { calls.push('a'); throw new Error('boom'); });
    block.onCleanup(() => { calls.push('b'); });

    block.finalize();
    expect(calls).toEqual(['a', 'b']); // second cleanup still ran
  });
});
