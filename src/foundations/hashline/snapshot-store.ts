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
import { lstatSync } from 'node:fs';

/** Authorization-time file identity captured by record() when the caller
 *  does not supply one. */
export interface FileIdentity {
  device: string;
  inode: string;
}

/** Best-effort lstat — a missing file (new-file flow) simply yields null. */
function statIdentity(path: string): FileIdentity | null {
  try {
    const st = lstatSync(path);
    return { device: String(st.dev), inode: String(st.ino) };
  } catch {
    return null;
  }
}

interface SnapshotEntry {
  path: string;
  content: string;
  tag: string;
  /** Authorization-time file identity (022-5-WO4 T006): when the read_file
   *  executor mints the tag it threads its ALREADY-VERIFIED fd stat here
   *  (compared against the authorize-time stamp before any byte was read) —
   *  callers without a pinned fd fall back to a best-effort lstat.
   *  Edit-section reads compare their pinned fd against it; a post-tag
   *  inode swap is denied. */
  device?: string;
  inode?: string;
}

export interface SnapshotStore {
  /** Record a snapshot and return its 4-hex tag. Empty string if oversized.
   *  `identity` threads the executor's ALREADY-VERIFIED fd identity
   *  (022-5-WO4 T006): when supplied it is authoritative — the mint-time
   *  lstat race disappears because the fd was pinned and compared before
   *  the read. When absent, a best-effort lstat is taken. */
  record(path: string, content: string, identity?: FileIdentity): string;
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
    record(path: string, content: string, identity?: FileIdentity): string {
      if (Buffer.byteLength(content, 'utf8') > MAX_SNAPSHOT_BYTES) {
        return ''; // empty tag signals "too large" — forces edit_file fallback
      }
      const tag = tagFor(path, content);
      // Caller-supplied identity (the executor's verified fd stat) is
      // authoritative — the mint-time lstat race disappears when the fd was
      // pinned and compared before the read. Fallback: best-effort lstat.
      const resolved = identity ?? statIdentity(path);
      byPath.set(path, {
        path, content, tag,
        device: resolved?.device,
        inode: resolved?.inode,
      });
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
