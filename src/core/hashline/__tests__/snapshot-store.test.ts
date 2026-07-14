/**
 * SnapshotStore unit tests.
 */
import { describe, it, expect } from 'vitest';
import { createSnapshotStore, tagFor } from '../snapshot-store.js';

describe('SnapshotStore', () => {
  it('records and resolves a snapshot by path', () => {
    const store = createSnapshotStore();
    const tag = store.record('/tmp/f.txt', 'hello world');
    expect(tag).toHaveLength(4);
    const resolved = store.resolvePath('/tmp/f.txt');
    expect(resolved?.content).toBe('hello world');
    expect(resolved?.tag).toBe(tag);
  });

  it('same content different paths yields different tags (regression: B1)', () => {
    const store = createSnapshotStore();
    const t1 = store.record('/a.txt', 'hello');
    const t2 = store.record('/b.txt', 'hello');
    expect(t1).not.toBe(t2);
    // Path-keyed resolve — no collision, each path resolves independently.
    expect(store.resolvePath('/a.txt')?.tag).toBe(t1);
    expect(store.resolvePath('/b.txt')?.tag).toBe(t2);
    expect(store.resolvePath('/a.txt')?.content).toBe('hello');
    expect(store.resolvePath('/b.txt')?.content).toBe('hello');
  });

  it('same content same path yields same tag (stable within path)', () => {
    const store = createSnapshotStore();
    const t1 = store.record('/f.txt', 'hello');
    const t2 = store.record('/f.txt', 'hello');
    expect(t1).toBe(t2);
  });

  it('returns empty tag for oversized content', () => {
    const store = createSnapshotStore();
    const big = 'x'.repeat(1_000_001);
    const tag = store.record('/big.txt', big);
    expect(tag).toBe('');
  });

  it('tagFor matches stored tag for matching content', () => {
    const store = createSnapshotStore();
    store.record('/f.txt', 'alpha');
    expect(tagFor('/f.txt', 'alpha')).toBe(store.resolvePath('/f.txt')?.tag);
  });

  it('tagFor differs when content changes', () => {
    const store = createSnapshotStore();
    store.record('/f.txt', 'alpha');
    const originalTag = store.resolvePath('/f.txt')?.tag;
    expect(tagFor('/f.txt', 'beta')).not.toBe(originalTag);
  });

  it('snapshot returns raw pre-edit content by path', () => {
    const store = createSnapshotStore();
    store.record('/f.txt', 'gamma');
    expect(store.snapshot('/f.txt')).toBe('gamma');
  });

  it('resolvePath returns null for unknown path', () => {
    const store = createSnapshotStore();
    expect(store.resolvePath('/nonexistent.txt')).toBeNull();
  });

  it('snapshot returns null for unknown path', () => {
    const store = createSnapshotStore();
    expect(store.snapshot('/unknown.txt')).toBeNull();
  });

  it('last write per path overwrites content and tag', () => {
    const store = createSnapshotStore();
    store.record('/f.txt', 'first');
    store.record('/f.txt', 'second');
    expect(store.resolvePath('/f.txt')?.content).toBe('second');
    expect(store.snapshot('/f.txt')).toBe('second');
  });
});
