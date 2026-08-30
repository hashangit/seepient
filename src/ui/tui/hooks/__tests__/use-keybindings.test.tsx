/**
 * Ctrl+C semantics (use-keybindings): abort mid-run, clear a draft at idle,
 * exit only when idle with an empty input.
 */
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { useKeybindings } from '../use-keybindings.js';

const delay = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

function mount(opts: { enabled?: boolean; isRunning?: boolean; hasDraft?: boolean }) {
  const events: string[] = [];
  function Harness() {
    useKeybindings(
      {
        onAbort: () => events.push('abort'),
        onExit: () => events.push('exit'),
        onClearDraft: () => events.push('clear-draft'),
        onExpandToggle: () => {},
        onPalette: () => {},
        onClear: () => {},
      },
      { enabled: true, isRunning: false, hasDraft: false, ...opts },
    );
    return null;
  }
  return { inst: render(<Harness />), events };
}

async function ctrlC(inst: { stdin: { write(s: string): void } }): Promise<void> {
  inst.stdin.write('\x03');
  await delay();
}

describe('useKeybindings Ctrl+C', () => {
  it('clears the draft at idle instead of exiting', async () => {
    const { inst, events } = mount({ hasDraft: true });
    await ctrlC(inst);
    expect(events).toEqual(['clear-draft']);
    inst.unmount();
  });

  it('exits at idle when the input is empty', async () => {
    const { inst, events } = mount({ hasDraft: false });
    await ctrlC(inst);
    expect(events).toEqual(['exit']);
    inst.unmount();
  });

  it('aborts mid-run even when a draft is present', async () => {
    const { inst, events } = mount({ isRunning: true, hasDraft: true });
    await ctrlC(inst);
    expect(events).toEqual(['abort']);
    inst.unmount();
  });

  it('does nothing while a modal overlay owns the keyboard', async () => {
    const { inst, events } = mount({ enabled: false, hasDraft: true });
    await ctrlC(inst);
    expect(events).toEqual([]);
    inst.unmount();
  });
});
