import { describe, it, expect, vi } from 'vitest';
import { createCliApproveTool } from '../repl.js';

describe('createCliApproveTool', () => {
  it('denies in non-interactive environment without autoConfirm and logs remediation copy', async () => {
    const isTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    try {
      const mockHandle = {
        suspend: vi.fn(),
        resume: vi.fn(),
      } as any;

      const approve = createCliApproveTool({}, mockHandle);
      const allowed = await approve({ name: 'execute_shell_command', args: { command: 'ls' } });

      expect(allowed).toBe(false);
      const allText = logs.join('\n');
      expect(allText).toContain('Command denied (non-interactive mode).');
      expect(allText).toContain('Pass --mode autonomous or --yes to auto-approve.');
    } finally {
      spy.mockRestore();
      Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
    }
  });

  it('auto-approves when config.autoConfirm is true and logs auto-approved message', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });

    try {
      const mockHandle = {
        suspend: vi.fn(),
        resume: vi.fn(),
      } as any;

      const approve = createCliApproveTool({ autoConfirm: true }, mockHandle);
      const allowed = await approve({ name: 'execute_shell_command', args: { command: 'ls' } });

      expect(allowed).toBe(true);
      const allText = logs.join('\n');
      expect(allText).toContain('(Auto-approved: --mode autonomous / --yes)');
    } finally {
      spy.mockRestore();
    }
  });
});
