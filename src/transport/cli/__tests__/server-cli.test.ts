import { describe, it, expect } from 'vitest';
import { parseServerCliArgs } from '../server-cli.js';

describe('parseServerCliArgs (FR-008)', () => {
  it('parses --port and --host correctly', () => {
    const args = parseServerCliArgs(['--port', '7401', '--host', '127.0.0.1']);
    expect(args.port).toBe(7401);
    expect(args.host).toBe('127.0.0.1');
  });

  it('parses --generate-api-key', () => {
    const args = parseServerCliArgs(['--generate-api-key']);
    expect(args.generateApiKey).toBe(true);
  });

  it('throws on unknown options naming the option', () => {
    expect(() => parseServerCliArgs(['--bogus'])).toThrow('Unknown option: "--bogus"');
  });

  it('honors SEEPIENT_PORT when flag not provided', () => {
    const old = process.env.SEEPIENT_PORT;
    try {
      process.env.SEEPIENT_PORT = '9999';
      const args = parseServerCliArgs([]);
      expect(args.port).toBe(9999);
    } finally {
      if (old !== undefined) process.env.SEEPIENT_PORT = old;
      else delete process.env.SEEPIENT_PORT;
    }
  });

  it('CLI flag takes precedence over SEEPIENT_PORT', () => {
    const old = process.env.SEEPIENT_PORT;
    try {
      process.env.SEEPIENT_PORT = '9999';
      const args = parseServerCliArgs(['--port', '8888']);
      expect(args.port).toBe(8888);
    } finally {
      if (old !== undefined) process.env.SEEPIENT_PORT = old;
      else delete process.env.SEEPIENT_PORT;
    }
  });
});
