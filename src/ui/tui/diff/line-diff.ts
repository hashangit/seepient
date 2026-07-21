/**
 * Pure line-diff view-model for the inline diff viewer.
 *
 * Uses the `diff` package's `diffLines` (the same engine the Pi coding agent
 * uses — see specs/006-inline-diff-viewer/research.md R1). CRLF/CR are
 * normalized to LF before comparison so a CRLF file doesn't diff as
 * fully-changed; the on-disk write is unaffected (research.md R5).
 */
import { diffLines } from 'diff';

export type DiffViewLine =
  | { kind: 'added'; newLineNo: number; text: string }
  | { kind: 'removed'; oldLineNo: number; text: string }
  | { kind: 'context'; oldLineNo: number; newLineNo: number; text: string };

const toLF = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/** Split a diff part's value into lines, dropping the trailing empty segment
 *  produced by a final newline (diff parts always end with \n). */
function splitLines(value: string): string[] {
  const segs = value.split('\n');
  if (segs.length > 0 && segs[segs.length - 1] === '') segs.pop();
  return segs;
}

/** Compute a line-level diff view-model. `oldContent === null` ⇒ new file
 *  (every line added). */
export function computeDiffLines(oldContent: string | null, newContent: string): DiffViewLine[] {
  const parts = diffLines(oldContent === null ? '' : toLF(oldContent), toLF(newContent));
  const out: DiffViewLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const part of parts) {
    for (const text of splitLines(part.value)) {
      if (part.added) {
        out.push({ kind: 'added', newLineNo: newNo, text });
        newNo++;
      } else if (part.removed) {
        out.push({ kind: 'removed', oldLineNo: oldNo, text });
        oldNo++;
      } else {
        out.push({ kind: 'context', oldLineNo: oldNo, newLineNo: newNo, text });
        oldNo++;
        newNo++;
      }
    }
  }
  return out;
}
