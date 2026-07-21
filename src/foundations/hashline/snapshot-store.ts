/**
 * T3 — SnapshotStore: file-content hash registry.
 *
 * Records file content hashes (4-hex tag per path). Resolution is
 * path-keyed — the tag is a version stamp verified on lookup. No
 * tag-only lookup means no hash-collision wrong-file risk.
 *
 * One store per session — not persisted (matches omp).
 * See `contracts/hashline-edit.md`.
 */

import * as crypto from 'crypto';

interface SnapshotEntry {
  path: string;
  content: string;
  tag: string;
}

export interface SnapshotStore {
  /** Record a snapshot and return its 4-hex tag. Empty string if oversized. */
  record(path: string, content: string): string;
  /** Path-keyed resolution — returns the stored tag + content for this path. */
  resolvePath(path: string): { tag: string; content: string } | null;
  /** Return the raw pre-edit content for a path (for stale-anchor reapply). */
  snapshot(path: string): string | null;
  clear(): void;
}

/** Tag is path-scoped: hash(path + NUL + content) ensures different paths
 *  with identical content never produce colliding tags. */
export function tagFor(path: string, content: string): string {
  return crypto.createHash('sha256')
    .update(path).update('\0').update(content)
    .digest('hex').slice(0, 4);
}

/** 1MB cap — skip recording for files above this threshold. */
const MAX_SNAPSHOT_BYTES = 1_000_000;

export function createSnapshotStore(): SnapshotStore {
  const byPath = new Map<string, SnapshotEntry>();

  return {
    record(path: string, content: string): string {
      if (Buffer.byteLength(content, 'utf8') > MAX_SNAPSHOT_BYTES) {
        return ''; // empty tag signals "too large" — forces edit_file fallback
      }
      const tag = tagFor(path, content);
      byPath.set(path, { path, content, tag });
      return tag;
    },

    resolvePath(path: string): { tag: string; content: string } | null {
      const entry = byPath.get(path);
      return entry ? { tag: entry.tag, content: entry.content } : null;
    },

    snapshot(path: string): string | null {
      return byPath.get(path)?.content ?? null;
    },

    clear(): void {
      byPath.clear();
    },
  };
}
