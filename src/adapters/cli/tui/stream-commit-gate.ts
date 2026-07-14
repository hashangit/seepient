/**
 * T2 — Streaming commit gate utilities.
 *
 * Applied at the display layer: decide how much of the accumulating streaming
 * text to show in the live region. Moves jittery half-formed output to a
 * held buffer, releasing it when structurally stable.
 *
 * See `contracts/widget-protocol.md` §7 and research.md R9.
 */

/** Check whether streaming markdown text has open fences or incomplete
 *  tables that would cause visual jitter if displayed in the live region. */
export function isLiveReflowingMarkdown(text: string): boolean {
  // Open fenced code block (odd number of ``` markers)
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) return true;

  // Incomplete GFM table: has |---| separator but the last line is still
  // a table row (more data may be coming).
  const lines = text.split('\n');
  let hasSeparator = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      if (line.match(/^\|[\s\-:]+\|$/)) {
        hasSeparator = true;
      }
    }
  }
  if (hasSeparator) {
    const lastLine = lines[lines.length - 1].trim();
    if (lastLine.startsWith('|') && lastLine.endsWith('|')) return true;
  }

  return false;
}

/** Trim trailing removal/add-only lines from streaming text that contains
 *  unified-diff output. Prevents "removals first, additions catching up"
 *  jitter when the assistant describes edits inline. */
export function stripTrailingUnbalancedRemoval(text: string): string {
  const lines = text.split('\n');
  // Walk from the end, trimming trailing removal lines (-lines) that
  // aren't followed by addition lines (+lines) in the same hunk.
  let trimIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith('-') && !line.startsWith('---')) {
      trimIdx = i;
    } else if (line.startsWith('+') || line.startsWith('@') || line.startsWith(' ')) {
      break;
    }
  }
  // Also trim trailing hunk headers (@@) that have no content after them
  for (let i = trimIdx - 1; i >= 0; i--) {
    if (lines[i].startsWith('@@')) {
      trimIdx = i;
    } else {
      break;
    }
  }
  if (trimIdx < lines.length) {
    return lines.slice(0, trimIdx).join('\n');
  }
  return text;
}

/**
 * Stabilize streaming text for live display. Returns the portion of `fullText`
 * that is safe to show, plus any text being held back for the next delta.
 */
export function stabilizeStreamingText(fullText: string): {
  stable: string;
  held: string;
  isHolding: boolean;
} {
  let stable = fullText;

  // Apply diff-jitter stripping if the text contains hunk headers
  if (stable.includes('@@')) {
    stable = stripTrailingUnbalancedRemoval(stable);
  }

  // Hold the commit if markdown is still reflowing
  if (isLiveReflowingMarkdown(stable)) {
    return { stable: '', held: stable, isHolding: true };
  }

  return { stable, held: '', isHolding: false };
}
