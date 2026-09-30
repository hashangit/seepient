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
  /** Authorization-time file identity (022-5-WO3 T005): captured when the
   *  tag is minted — record() runs after the read_file identity pin, so this
   *  IS the authorized file's dev/ino. Edit-section reads compare their
   *  pinned fd against it; a post-tag inode swap is denied. */
  device?: string;
  inode?: string;
}

export interface SnapshotStore {
  /** Record a snapshot and return its 4-hex tag. Empty string if oversized. */
  record(path: string, content: string): string;
  /** Path-keyed resolution — returns the stored tag + content for this path. */
  resolvePath(path: string): { tag: string; content: string } | null;
  /** The recorded authorization-time identity for this path, if captured. */
  identityOf(path: string): { device: string; inode: string } | null;
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
      // Identity capture is best-effort: a missing file (new-file flow) or a
      // stat failure simply leaves the entry without identity, and the
      // section-read pin fails open ONLY for that absent case.
      let device: string | undefined;
      let inode: string | undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const st = require('node:fs').lstatSync(path);
        device = String(st.dev);
        inode = String(st.ino);
      } catch {
        /* new-file or vanished — no identity recorded */
      }
      byPath.set(path, { path, content, tag, device, inode });
      return tag;
    },

    resolvePath(path: string): { tag: string; content: string } | null {
      const entry = byPath.get(path);
      return entry ? { tag: entry.tag, content: entry.content } : null;
    },

    identityOf(path: string): { device: string; inode: string } | null {
      const entry = byPath.get(path);
      if (!entry?.device || !entry.inode) return null;
      return { device: entry.device, inode: entry.inode };
    },

    snapshot(path: string): string | null {
      return byPath.get(path)?.content ?? null;
    },

    clear(): void {
      byPath.clear();
    },
  };
}
