/**
 * Boundary parse guard for `write_file`'s tool-result metadata.
 *
 * `StepResult.metadata` is an opaque `Record<string, unknown>` at the core
 * level; the TUI must parse it before use (constitution: parse, don't cast).
 * The `FileWriteMetadata` contract lives in `foundations/contracts/presentation.ts`,
 * shared by the producer (`capabilities/tools/core.ts`) and this renderer —
 * neither imports the other.
 */
import type { FileWriteMetadata } from '../../../foundations/contracts/presentation.js';

export function isFileWriteMetadata(u: unknown): u is FileWriteMetadata {
  if (typeof u !== 'object' || u === null) return false;
  const m = u as Record<string, unknown>;
  return (
    typeof m.path === 'string' &&
    typeof m.isNewFile === 'boolean' &&
    typeof m.byteDelta === 'number' &&
    // oldContent, when present, is a string or null; newContent is a string.
    (m.oldContent === undefined || m.oldContent === null || typeof m.oldContent === 'string') &&
    (m.newContent === undefined || typeof m.newContent === 'string')
  );
}
