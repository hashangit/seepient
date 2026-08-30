/**
 * Hashline parser unit tests.
 */
import { describe, it, expect } from 'vitest';
import { parsePatch } from '../parser.js';

describe('parsePatch', () => {
  it('parses a single SWAP section', () => {
    const src = `[file.txt#a1f2]
SWAP 3.=5:
+line three
+line four
+line five`;
    const result = parsePatch(src);
    expect(result.sections).toHaveLength(1);
    const s = result.sections[0];
    expect(s.path).toBe('file.txt');
    expect(s.tag).toBe('a1f2');
    expect(s.operations).toHaveLength(1);
    const op = s.operations[0];
    expect(op.type).toBe('swap');
    expect((op as any).startLine).toBe(3);
    expect((op as any).endLine).toBe(5);
    expect((op as any).body).toEqual(['line three', 'line four', 'line five']);
  });

  it('parses SWAP without trailing colon', () => {
    const src = `[f#abcd]
SWAP 1.=1:
+hello`;
    const result = parsePatch(src);
    expect(result.sections[0].operations[0].type).toBe('swap');
  });

  it('parses DEL', () => {
    const src = `[f#beef]
DEL 2.=4`;
    const result = parsePatch(src);
    const op = result.sections[0].operations[0];
    expect(op.type).toBe('del');
    expect((op as any).startLine).toBe(2);
    expect((op as any).endLine).toBe(4);
  });

  it('parses INS.PRE, INS.POST, INS.HEAD, INS.TAIL', () => {
    const src = `[f#aaaa]
INS.PRE 1:
+top
INS.POST 3:
+after
INS.HEAD:
+very top
INS.TAIL:
+very bottom`;
    const ops = parsePatch(src).sections[0].operations;
    expect(ops).toHaveLength(4);
    expect(ops[0]).toMatchObject({ type: 'ins_pre', line: 1 });
    expect(ops[1]).toMatchObject({ type: 'ins_post', line: 3 });
    expect(ops[2]).toMatchObject({ type: 'ins_head' });
    expect(ops[3]).toMatchObject({ type: 'ins_tail' });
  });

  it('parses SWAP.BLK and DEL.BLK', () => {
    const src = `[f#eeee]
SWAP.BLK 42:
+replaced
DEL.BLK 7`;
    const ops = parsePatch(src).sections[0].operations;
    expect(ops[0]).toMatchObject({ type: 'swap_block', startLine: 42 });
    expect((ops[0] as any).body).toEqual(['replaced']);
    expect(ops[1]).toMatchObject({ type: 'del_block', startLine: 7 });
  });

  it('rejects MV (not implemented)', () => {
    expect(() => parsePatch('[f#cccc]\nMV other/path.ts')).toThrow(/not yet implemented/);
  });

  it('rejects REM (not implemented)', () => {
    expect(() => parsePatch('[f#cccc]\nREM')).toThrow(/not yet implemented/);
  });

  it('parses multiple sections', () => {
    const src = `[a.txt#1111]
SWAP 1.=1:
+changed

[b.txt#2222]
DEL 3.=3`;
    const result = parsePatch(src);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].path).toBe('a.txt');
    expect(result.sections[1].path).toBe('b.txt');
  });

  it('accepts uppercase hex tags', () => {
    const src = `[f#ABCD]
SWAP 1.=1:
+x`;
    expect(parsePatch(src).sections[0].tag).toBe('abcd');
  });

  it('throws on missing section header', () => {
    expect(() => parsePatch('SWAP 1.=1:\n+body')).toThrow(/HASHLINE_PARSE_ERROR|Patch must start/);
  });

  it('throws on unknown operation', () => {
    expect(() => parsePatch('[f#aaaa]\nFOO 1')).toThrow(/HASHLINE_PARSE_ERROR|Unknown operation/);
  });

  it('throws on invalid SWAP syntax', () => {
    expect(() => parsePatch('[f#aaaa]\nSWAP bad')).toThrow(/HASHLINE_PARSE_ERROR|Invalid SWAP/);
  });

  it('throws on empty patch', () => {
    expect(() => parsePatch('')).toThrow(/HASHLINE_PARSE_ERROR|no sections/);
  });

  it('skips blank lines between ops', () => {
    const src = `[f#bbbb]
DEL 1.=1

DEL 2.=2`;
    const result = parsePatch(src);
    expect(result.sections[0].operations).toHaveLength(2);
  });

  it('parses DEL and DEL.BLK with optional trailing colon', () => {
    const src = `[f#beef]
DEL 2.=4:
DEL.BLK 7:`;
    const result = parsePatch(src);
    expect(result.sections[0].operations).toHaveLength(2);
    expect(result.sections[0].operations[0]).toMatchObject({ type: 'del', startLine: 2, endLine: 4 });
    expect(result.sections[0].operations[1]).toMatchObject({ type: 'del_block', startLine: 7 });
  });

  it('parses the exact example from the edit_file tool description', () => {
    const example = `[/src/app.ts#a1f2]
SWAP 2.=2:
+const x = 2;`;
    const result = parsePatch(example);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].path).toBe('/src/app.ts');
    expect(result.sections[0].tag).toBe('a1f2');
    expect(result.sections[0].operations[0]).toMatchObject({
      type: 'swap',
      startLine: 2,
      endLine: 2,
      body: ['const x = 2;'],
    });
  });
});
