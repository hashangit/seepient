/**
 * TextInput paste semantics — multi-line pastes must keep every line and never
 * submit mid-paste (bug: per-line paste chunks delivered `\r` as its own stdin
 * chunk → key.return → onSubmit cleared every line but the last).
 *
 * ink-testing-library note: setState from useInput renders on the next tick —
 * every stdin write goes through `type()` which awaits a frame.
 */
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React, { useState } from 'react';
import { TextInput } from '../text-input.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const SHIFT_ENTER_CSI = '\x1b[27;2;13~';

const delay = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

async function type(inst: { stdin: { write(s: string): void } }, s: string): Promise<void> {
  inst.stdin.write(s);
  await delay();
}

function setup() {
  const state = { value: '', submits: [] as string[] };
  const Harness = () => {
    const [value, setValue] = useState('');
    return (
      <TextInput
        value={value}
        onChange={(v) => { state.value = v; setValue(v); }}
        onSubmit={(v) => { state.submits.push(v); setValue(''); state.value = ''; }}
        placeholder="ask"
      />
    );
  };
  return { inst: render(<Harness />), state };
}

describe('TextInput paste handling', () => {
  it('enables bracketed paste mode while mounted', async () => {
    const { inst } = setup();
    expect(inst.stdout.frames.join('')).toContain('\x1b[?2004h');
    inst.unmount();
    await delay();
    expect(inst.stdout.frames.join('')).toContain('\x1b[?2004l');
  });

  it('keeps every line of a bracketed paste split across chunks and never submits', async () => {
    const { inst, state } = setup();
    await type(inst, `${PASTE_START}line1\r`);
    await type(inst, 'line2\r');
    await type(inst, `line3${PASTE_END}`);
    expect(state.value).toBe('line1\nline2\nline3');
    expect(state.submits).toEqual([]);
    inst.unmount();
  });

  it('treats solo CR chunks inside a paste as newlines, not Enter (the reported bug)', async () => {
    const { inst, state } = setup();
    await type(inst, PASTE_START);
    await type(inst, 'line1');
    await type(inst, '\r');
    await type(inst, 'line2');
    await type(inst, '\r');
    await type(inst, 'line3');
    await type(inst, PASTE_END);
    expect(state.value).toBe('line1\nline2\nline3');
    expect(state.submits).toEqual([]);
    inst.unmount();
  });

  it('keeps every line of a bracketed paste delivered as one burst', async () => {
    const { inst, state } = setup();
    await type(inst, `${PASTE_START}one\r\ntwo\r\nthree${PASTE_END}`);
    expect(state.value).toBe('one\ntwo\nthree');
    expect(state.submits).toEqual([]);
    inst.unmount();
  });

  it('normalizes an unbracketed single-burst paste (no 2004 terminal support)', async () => {
    const { inst, state } = setup();
    await type(inst, 'first\r\nsecond\r\nthird');
    expect(state.value).toBe('first\nsecond\nthird');
    expect(state.submits).toEqual([]);
    inst.unmount();
  });

  it('concatenates unbracketed per-line paste chunks without submitting', async () => {
    const { inst, state } = setup();
    await type(inst, 'one\r');
    await type(inst, 'two\r');
    await type(inst, 'three');
    expect(state.value).toBe('one\ntwo\nthree');
    expect(state.submits).toEqual([]);
    inst.unmount();
  });

  it('treats machine-paced solo CRs as paste newlines (unbracketed split paste)', async () => {
    const { inst, state } = setup();
    // ~1ms inter-chunk gaps = machine-paced (< 10 ms window), as a terminal
    // without 2004 support delivers a per-line-split paste; each write is its
    // own event-loop turn, so renders commit between chunks like production.
    for (const chunk of ['line one', '\r', 'line two', '\r', 'line three']) {
      inst.stdin.write(chunk);
      await new Promise((r) => setImmediate(r));
    }
    await delay();
    expect(state.value).toBe('line one\nline two\nline three');
    expect(state.submits).toEqual([]);
    inst.unmount();
  });

  it('still submits on a lone Enter', async () => {
    const { inst, state } = setup();
    await type(inst, 'hello');
    await type(inst, '\r');
    expect(state.submits).toEqual(['hello']);
    expect(state.value).toBe('');
    inst.unmount();
  });

  it('still inserts a newline on the Shift+Enter CSI sequence', async () => {
    const { inst, state } = setup();
    await type(inst, 'a');
    await type(inst, SHIFT_ENTER_CSI);
    expect(state.value).toBe('a\n');
    expect(state.submits).toEqual([]);
    inst.unmount();
  });
});
