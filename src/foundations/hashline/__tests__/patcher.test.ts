/**
 * Hashline patcher unit tests.
 *
 * These test the CORE functionality: applyOp, sortOpsBottomToTop, and
 * the stale-anchor fail-closed behavior in tryReapplyOrReject.
 */
import { describe, it, expect } from 'vitest';
import { applyOp, sortOpsBottomToTop, tryReapplyOrReject } from '../patcher.js';
import type { HashlineOp } from '../types.js';

// Direct applyOp tests (pure functions, no fs).

describe('applyOp', () => {
  const lines = ['one', 'two', 'three', 'four', 'five'];

  it('SWAP replaces a single line', () => {
    const op: HashlineOp = { type: 'swap', startLine: 3, endLine: 3, body: ['THREE'] };
    const result = applyOp(lines, op);
    expect(result).toEqual(['one', 'two', 'THREE', 'four', 'five']);
  });

  it('SWAP replaces a range', () => {
    const op: HashlineOp = { type: 'swap', startLine: 2, endLine: 4, body: ['new'] };
    const result = applyOp(lines, op);
    expect(result).toEqual(['one', 'new', 'five']);
  });

  it('SWAP out of range throws', () => {
    const op: HashlineOp = { type: 'swap', startLine: 10, endLine: 12, body: [] };
    expect(() => applyOp(lines, op)).toThrow(/HASHLINE_OUT_OF_RANGE|out of range/);
  });

  it('DEL removes a range', () => {
    const op: HashlineOp = { type: 'del', startLine: 2, endLine: 3 };
    expect(applyOp(lines, op)).toEqual(['one', 'four', 'five']);
  });

  it('INS.PRE inserts before a line', () => {
    const op: HashlineOp = { type: 'ins_pre', line: 3, body: ['inserted'] };
    expect(applyOp(lines, op)).toEqual(['one', 'two', 'inserted', 'three', 'four', 'five']);
  });

  it('INS.POST inserts after a line', () => {
    const op: HashlineOp = { type: 'ins_post', line: 3, body: ['inserted'] };
    expect(applyOp(lines, op)).toEqual(['one', 'two', 'three', 'inserted', 'four', 'five']);
  });

  it('INS.POST out of range throws', () => {
    const op: HashlineOp = { type: 'ins_post', line: 99, body: ['oops'] };
    expect(() => applyOp(lines, op)).toThrow(/HASHLINE_OUT_OF_RANGE|out of range/);
  });

  it('INS.PRE out of range throws', () => {
    const op: HashlineOp = { type: 'ins_pre', line: -1, body: ['oops'] };
    expect(() => applyOp(lines, op)).toThrow(/HASHLINE_OUT_OF_RANGE|out of range/);
  });

  it('SWAP.BLK swaps an indented block', () => {
    const blockLines = ['header', '  child1', '  child2', 'footer'];
    const op: HashlineOp = { type: 'swap_block', startLine: 1, body: ['NEW_HEADER'] };
    expect(applyOp(blockLines, op)).toEqual(['NEW_HEADER', 'footer']);
  });

  it('SWAP.BLK preserves deeper nesting', () => {
    const blockLines = ['root', '  level1', '    level2', '  sibling', 'after'];
    // block at line 1 (root) spans to indent=0 at 'after'
    const op: HashlineOp = { type: 'swap_block', startLine: 1, body: ['NEW_ROOT'] };
    expect(applyOp(blockLines, op)).toEqual(['NEW_ROOT', 'after']);
  });

  it('DEL.BLK deletes an indented block', () => {
    const blockLines = ['header', '  child1', '  child2', 'footer'];
    const op: HashlineOp = { type: 'del_block', startLine: 1 };
    expect(applyOp(blockLines, op)).toEqual(['footer']);
  });

  it('INS.HEAD prepends', () => {
    const op: HashlineOp = { type: 'ins_head', body: ['top'] };
    expect(applyOp(lines, op)).toEqual(['top', 'one', 'two', 'three', 'four', 'five']);
  });

  it('INS.TAIL appends', () => {
    const op: HashlineOp = { type: 'ins_tail', body: ['bottom'] };
    expect(applyOp(lines, op)).toEqual(['one', 'two', 'three', 'four', 'five', 'bottom']);
  });
});

describe('sortOpsBottomToTop', () => {
  it('puts higher-line ops first', () => {
    const ops: HashlineOp[] = [
      { type: 'swap', startLine: 1, endLine: 1, body: ['a'] },
      { type: 'swap', startLine: 10, endLine: 10, body: ['b'] },
      { type: 'swap', startLine: 5, endLine: 5, body: ['c'] },
    ];
    const sorted = sortOpsBottomToTop(ops);
    expect(sorted[0].type === 'swap' && (sorted[0] as any).startLine).toBe(10);
    expect(sorted[1].type === 'swap' && (sorted[1] as any).startLine).toBe(5);
    expect(sorted[2].type === 'swap' && (sorted[2] as any).startLine).toBe(1);
  });

  it('puts INS.TAIL after everything', () => {
    const ops: HashlineOp[] = [
      { type: 'swap', startLine: 1, endLine: 1, body: ['a'] },
      { type: 'ins_tail', body: ['b'] },
    ];
    const sorted = sortOpsBottomToTop(ops);
    // ins_tail has anchor Infinity → comes first
    expect(sorted[0].type).toBe('ins_tail');
  });

  it('puts INS.HEAD before everything', () => {
    const ops: HashlineOp[] = [
      { type: 'ins_head', body: ['a'] },
      { type: 'swap', startLine: 99, endLine: 99, body: ['b'] },
    ];
    const sorted = sortOpsBottomToTop(ops);
    // swap line 99 > ins_head 0
    expect(sorted[0].type).toBe('swap');
    expect(sorted[1].type).toBe('ins_head');
  });

  it('correctly orders after line shifts (integration)', () => {
    // INS.POST 3 adds lines, then DEL 5 works on shifted line.
    // Sorted bottom-to-top: DEL 5 first (line 5 unchanged), then INS.POST 3.
    const ops: HashlineOp[] = [
      { type: 'ins_post', line: 3, body: ['x', 'y'] },
      { type: 'del', startLine: 5, endLine: 5 },
    ];
    const sorted = sortOpsBottomToTop(ops);
    expect(sorted[0].type).toBe('del');     // line 5 > line 3
    expect(sorted[1].type).toBe('ins_post');
  });
});

describe('tryReapplyOrReject', () => {
  it('accepts trivial merge: patched snapshot equals current', () => {
    // Snapshot: "alpha\nbeta", patch swaps line 2 to "beta_new"
    // After swap: "alpha\nbeta_new"
    // Current (no external change): "alpha\nbeta_new"
    // Result: ok=true, trivially identical.
    const snapshot = 'alpha\nbeta';
    const current = 'alpha\nbeta_new';
    const ops: HashlineOp[] = [{ type: 'swap', startLine: 2, endLine: 2, body: ['beta_new'] }];
    const result = tryReapplyOrReject(snapshot, current, ops);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(current);
  });

  it('fails closed on divergent content', () => {
    // Snapshot: "alpha\nbeta\ngamma"
    // Patch: swap line 2 to "beta_new"
    // Current (externally changed): "alpha\nbeta\ngamma\Delta" (extra line)
    // Patched snapshot = "alpha\nbeta_new\ngamma" ≠ current → fail closed.
    const snapshot = 'alpha\nbeta\ngamma';
    const current = 'alpha\nbeta\ngamma\Delta';
    const ops: HashlineOp[] = [{ type: 'swap', startLine: 2, endLine: 2, body: ['beta_new'] }];
    const result = tryReapplyOrReject(snapshot, current, ops);
    expect(result.ok).toBe(false);
    expect(result.content).toBeUndefined();
  });

  it('fails closed when snapshot and current diverge completely', () => {
    const snapshot = 'one\ntwo';
    const current = 'completely\ndifferent';
    const ops: HashlineOp[] = [{ type: 'swap', startLine: 1, endLine: 1, body: ['ONE'] }];
    const result = tryReapplyOrReject(snapshot, current, ops);
    expect(result.ok).toBe(false);
  });

  it('fails closed when ops are empty (snapshot ≠ current)', () => {
    const snapshot = 'alpha';
    const current = 'alpha\nbeta';
    const ops: HashlineOp[] = [];
    const result = tryReapplyOrReject(snapshot, current, ops);
    expect(result.ok).toBe(false);
  });

  it('handles invalid op (catches and returns ok: false)', () => {
    const snapshot = 'line1';
    const current = 'line1';
    const ops: HashlineOp[] = [{ type: 'swap', startLine: 99, endLine: 99, body: [] }];
    const result = tryReapplyOrReject(snapshot, current, ops);
    expect(result.ok).toBe(false);
  });
});

