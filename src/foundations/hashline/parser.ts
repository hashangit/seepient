/**
 * T3 — Hashline patch parser.
 *
 * Parses the hashline patch grammar into structured HashlinePatch.
 * v1 scope: SWAP, SWAP.BLK, DEL, DEL.BLK, INS.PRE/POST/HEAD/TAIL.
 * MV and REM are rejected (not yet implemented).
 *
 * See `contracts/hashline-edit.md` §2.
 */

import { HashlineError } from '../errors.js';
import type { HashlineSection, HashlineOp } from './types.js';

function hashError(msg: string, code: string, retryable: boolean): never {
  throw new HashlineError(msg, code, retryable);
}

/** Parse a hashline patch string into sections. */
export function parsePatch(source: string): { sections: HashlineSection[] } {
  const sections: HashlineSection[] = [];
  const lines = source.split('\n');

  let currentSection: { path: string; tag: string; ops: HashlineOp[] } | null = null;
  let currentOp: HashlineOp | null = null;
  let bodyLines: string[] = [];

  function flushOp(): void {
    if (currentOp && currentSection) {
      if (bodyLines.length > 0 && 'body' in currentOp) {
        (currentOp as { body: string[] }).body = bodyLines;
      }
      currentSection.ops.push(currentOp);
    }
    currentOp = null;
    bodyLines = [];
  }

  function flushSection(): void {
    flushOp();
    if (currentSection) {
      sections.push({ path: currentSection.path, tag: currentSection.tag, operations: currentSection.ops });
      currentSection = null;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) continue;

    // Section header: [PATH#TAG]
    const headerMatch = line.match(/^\[(.+)#([0-9a-f]{4})\]$/i);
    if (headerMatch) {
      flushSection();
      currentSection = { path: headerMatch[1], tag: headerMatch[2].toLowerCase(), ops: [] };
      continue;
    }

    if (!currentSection) {
      hashError(`Patch must start with a [PATH#TAG] section header. Expected e.g. [/abs/path.ts#a1f2] where a1f2 is the content-tag from read_file`, 'HASHLINE_PARSE_ERROR', true);
    }

    // Body continuation: +text
    if (line.startsWith('+')) {
      bodyLines.push(line.slice(1));
      continue;
    }

    // Flush previous op before starting new one
    flushOp();

    // Parse op header
    const parts = line.split(':')[0].trim().split(/\s+/);
    const opKind = parts[0].toUpperCase();

    if (opKind === 'SWAP') {
      // SWAP start.=end:
      const rangeMatch = line.match(/SWAP\s+(\d+)\.=(\d+)\s*:?\s*$/i);
      if (!rangeMatch) hashError(`Invalid SWAP syntax: "${line}". Expected "SWAP A.=B:" with just the range on the op line (single line: 2.=2) and new content on following lines prefixed "+", e.g. SWAP 2.=2:`, 'HASHLINE_PARSE_ERROR', true);
      currentOp = { type: 'swap', startLine: parseInt(rangeMatch[1], 10), endLine: parseInt(rangeMatch[2], 10), body: [] };
    } else if (opKind === 'SWAP.BLK') {
      const blkMatch = line.match(/SWAP\.BLK\s+(\d+)\s*:?\s*$/i);
      if (!blkMatch) hashError(`Invalid SWAP.BLK syntax: "${line}"`, 'HASHLINE_PARSE_ERROR', true);
      currentOp = { type: 'swap_block', startLine: parseInt(blkMatch[1], 10), body: [] };
    } else if (opKind === 'DEL') {
      const delMatch = line.match(/DEL\s+(\d+)\.=(\d+)\s*:?\s*$/i);
      if (!delMatch) hashError(`Invalid DEL syntax: "${line}". Expected "DEL A.=B" (single line: 2.=2)`, 'HASHLINE_PARSE_ERROR', true);
      currentOp = { type: 'del', startLine: parseInt(delMatch[1], 10), endLine: parseInt(delMatch[2], 10) };
    } else if (opKind === 'DEL.BLK') {
      const blkMatch = line.match(/DEL\.BLK\s+(\d+)\s*:?\s*$/i);
      if (!blkMatch) hashError(`Invalid DEL.BLK syntax: "${line}"`, 'HASHLINE_PARSE_ERROR', true);
      currentOp = { type: 'del_block', startLine: parseInt(blkMatch[1], 10) };
    } else if (opKind === 'INS.PRE' || opKind === 'INS.POST' || opKind === 'INS.HEAD' || opKind === 'INS.TAIL') {
      const insMatch = line.match(/(INS\.\w+)\s+(\d+)\s*:?\s*$/i);
      const lineNum = insMatch ? parseInt(insMatch[2], 10) : undefined;
      const insType = opKind.toLowerCase().replace('.', '_') as 'ins_pre' | 'ins_post' | 'ins_head' | 'ins_tail';
      currentOp = { type: insType, line: lineNum, body: [] };
    } else if (opKind === 'MV') {
      hashError('MV (move) operation is not yet implemented', 'HASHLINE_PARSE_ERROR', true);
    } else if (opKind === 'REM') {
      hashError('REM (remove) operation is not yet implemented', 'HASHLINE_PARSE_ERROR', true);
    } else {
      hashError(`Unknown operation: "${opKind}". If this was file content, prefix the line with "+" (body rows must start with +)`, 'HASHLINE_PARSE_ERROR', true);
    }
  }

  flushSection();

  if (sections.length === 0) {
    hashError('Patch contains no sections', 'HASHLINE_PARSE_ERROR', true);
  }

  return { sections };
}

/** Resolve a BLK operation to line ranges using indentation-based blocks. */
export function resolveBlock(lines: string[], startLine: number): { start: number; end: number } {
  const idx = startLine - 1; // 1-based → 0-based
  if (idx < 0 || idx >= lines.length) {
    hashError(`Line ${startLine} out of range (file has ${lines.length} lines)`, 'HASHLINE_OUT_OF_RANGE', true);
  }
  const baseIndent = lines[idx].match(/^(\s*)/)?.[1].length ?? 0;

  // Find the end of the block: next line at <= baseIndent (excluding blank lines)
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue; // skip blank lines
    const indent = lines[i].match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= baseIndent) {
      end = i;
      break;
    }
  }
  return { start: idx, end };
}
