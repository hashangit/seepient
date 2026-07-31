/**
 * T3 — Hashline patcher.
 *
 * Applies hashline operations to file content, with hash verification.
 * Stale anchors fail closed (reapply-and-reject, not a full 3-way merge).
 * Uses atomic write (temp + fs.rename) from 006.
 * Returns FileWriteMetadata for the DiffViewer.
 *
 * See `contracts/hashline-edit.md`.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { HashlineError } from '../errors.js';
import type { SnapshotStore } from './snapshot-store.js';
import { tagFor } from './snapshot-store.js';
import { parsePatch, resolveBlock } from './parser.js';
import type { HashlineOp } from './types.js';

export interface FileWriteMetadata {
  path: string;
  oldContent: string | null;
  newContent: string;
  isNewFile: boolean;
  byteDelta: number;
  editSource?: string;
  diffSkipped?: boolean;
}

export interface EditFileResult {
  output: string;
  success: boolean;
  metadata: FileWriteMetadata | { edits: FileWriteMetadata[] };
}

// Atomic write (temp in same dir + fs.rename; same naming as core.ts).
// The 006 sweeper (core.ts:cleanStaleTemps) matches ${basename}.seepient-*.tmp.
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `${base}.seepient-${randomUUID().slice(0, 8)}.tmp`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, filePath);
  } catch (error: unknown) {
    try { await fs.unlink(tmpPath); } catch { /* temp may not have been created */ }
    throw error;
  }
}

/** Return the highest line number an op targets. Used for bottom-to-top
 *  sorting so sequential application doesn't shift subsequent line numbers. */
function opAnchorLine(op: HashlineOp): number {
  switch (op.type) {
    case 'swap': return op.endLine;
    case 'swap_block': return op.startLine; // resolved to block range at apply time
    case 'del': return op.endLine;
    case 'del_block': return op.startLine;
    case 'ins_post': return op.line ?? Infinity;
    case 'ins_pre': return op.line ?? 1;
    case 'ins_head': return 0;
    case 'ins_tail': return Infinity;
  }
}

/** Sort ops bottom-to-top so applying them sequentially doesn't shift
 *  line numbers of ops that appear earlier in the file. */
export function sortOpsBottomToTop(ops: HashlineOp[]): HashlineOp[] {
  return [...ops].sort((a, b) => opAnchorLine(b) - opAnchorLine(a));
}

export function applyOp(lines: string[], op: HashlineOp): string[] {
  switch (op.type) {
    case 'swap': {
      const start = op.startLine - 1;
      const end = op.endLine;
      if (start < 0 || end > lines.length) throw new HashlineError(`SWAP out of range: lines ${op.startLine}-${op.endLine}`, 'HASHLINE_OUT_OF_RANGE', true);
      return [...lines.slice(0, start), ...op.body, ...lines.slice(end)];
    }
    case 'swap_block': {
      const block = resolveBlock(lines, op.startLine);
      return [...lines.slice(0, block.start), ...op.body, ...lines.slice(block.end)];
    }
    case 'del': {
      const start = op.startLine - 1;
      const end = op.endLine;
      if (start < 0 || end > lines.length) throw new HashlineError(`DEL out of range: lines ${op.startLine}-${op.endLine}`, 'HASHLINE_OUT_OF_RANGE', true);
      return [...lines.slice(0, start), ...lines.slice(end)];
    }
    case 'del_block': {
      const block = resolveBlock(lines, op.startLine);
      return [...lines.slice(0, block.start), ...lines.slice(block.end)];
    }
    case 'ins_pre': {
      const pos = (op.line ?? 1) - 1;
      if (pos < 0 || pos > lines.length) throw new HashlineError(`INS.PRE out of range: line ${op.line}`, 'HASHLINE_OUT_OF_RANGE', true);
      return [...lines.slice(0, pos), ...op.body, ...lines.slice(pos)];
    }
    case 'ins_post': {
      const pos = op.line ?? lines.length;
      if (pos < 0 || pos > lines.length) throw new HashlineError(`INS.POST out of range: line ${op.line}`, 'HASHLINE_OUT_OF_RANGE', true);
      return [...lines.slice(0, pos), ...op.body, ...lines.slice(pos)];
    }
    case 'ins_head':
      return [...op.body, ...lines];
    case 'ins_tail':
      return [...lines, ...op.body];
  }
}

/** Reapply ops to the snapshot. Accept only if the result exactly matches current
 *  (trivial merge). Otherwise fail closed — the agent re-reads and retries with
 *  a fresh tag. This is a fail-closed guard, not a true 3-way merge. */
export function tryReapplyOrReject(snapshot: string, current: string, ops: HashlineOp[]): { ok: boolean; content?: string } {
  try {
    const snapshotLines = snapshot.split('\n');
    let merged = snapshotLines;
    for (const op of ops) merged = applyOp(merged, op);
    const mergedText = merged.join('\n');

    // Trivial case: the patched snapshot already matches current. Accept.
    if (mergedText === current) return { ok: true, content: current };

    // Non-trivial: snapshot and current diverge. Fail closed — contract says
    // throw HASHLINE_STALE_ANCHOR, agent re-reads, retries with a fresh tag.
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Apply an edit_file patch to one or more files.
 *
 *  Atomicity: every section is validated and its result computed in memory
 *  (pass 1) BEFORE any file is written (pass 2). A failure in any section
 *  therefore leaves all files unchanged — no partial multi-file edits. */
export async function applyPatch(
  patchSource: string,
  store: SnapshotStore,
): Promise<EditFileResult> {
  const patch = parsePatch(patchSource);

  // Pass 1 — resolve + apply every section in memory. Any validation failure
  // (unknown tag, stale anchor, out-of-range op) throws here, before any write.
  const pending: Array<{ filePath: string; current: string; applied: string }> = [];
  for (const section of patch.sections) {
    const { path: filePath, tag } = section;
    const resolved = store.resolvePath(filePath);
    if (!resolved) {
      throw new HashlineError(`No snapshot for path: ${filePath}`, 'HASHLINE_UNKNOWN_TAG', false);
    }
    if (resolved.tag !== tag) {
      throw new HashlineError(`Stale tag for ${filePath} — file changed since snapshot`, 'HASHLINE_STALE_ANCHOR', true);
    }

    const current = await fs.readFile(filePath, 'utf8');
    const currentTag = tagFor(filePath, current);
    const currentLines = current.split('\n');
    let applied: string;

    if (currentTag !== resolved.tag) {
      // Stale anchor: reapply ops to snapshot, accept only if result matches current
      const snapshotContent = store.snapshot(filePath);
      if (!snapshotContent) {
        throw new HashlineError(`Stale anchor for ${filePath} (no snapshot)`, 'HASHLINE_STALE_ANCHOR', true);
      }
      const merged = tryReapplyOrReject(snapshotContent, current, section.operations);
      if (!merged.ok || !merged.content) {
        throw new HashlineError(`Stale anchor for ${filePath} — file changed since snapshot`, 'HASHLINE_STALE_ANCHOR', true);
      }
      applied = merged.content;
    } else {
      let targetLines = currentLines;
      for (const op of sortOpsBottomToTop(section.operations)) {
        targetLines = applyOp(targetLines, op);
      }
      applied = targetLines.join('\n');
    }

    pending.push({ filePath, current, applied });
  }

  // Pass 2 — all sections validated; now write. (Single-file edits write once,
  // as before. Multi-file edits write all-or-nothing relative to this call.)
  const results: FileWriteMetadata[] = [];
  for (const { filePath, current, applied } of pending) {
    await atomicWrite(filePath, applied);
    store.record(filePath, applied);
    results.push({
      path: filePath,
      oldContent: current,
      newContent: applied,
      isNewFile: false,
      byteDelta: Buffer.byteLength(applied) - Buffer.byteLength(current),
      editSource: 'hashline',
    });
  }

  return {
    output: `Edited ${results.length} file(s): ${results.map((r) => r.path).join(', ')}`,
    success: true,
    metadata: results.length === 1 ? results[0] : { edits: results },
  };
}
