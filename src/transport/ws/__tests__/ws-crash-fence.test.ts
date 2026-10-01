import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleWsUpdateSettings } from '../../http/settings-handlers.js';

const repoRoot = path.resolve(__dirname, '../../../..');

describe('WS crash fence (FR-005)', () => {
  it('grep-assert: no ws.send( outside the safe sender in connection-registry.ts', () => {
    const transportDir = path.join(repoRoot, 'src/transport');
    const violations: string[] = [];

    function scan(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue;
          scan(full);
        } else if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) {
          // Allow connection-registry.ts where safeSend is defined
          if (entry.name === 'connection-registry.ts') continue;
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (/\bws\.send\s*\(/.test(lines[i])) {
              violations.push(`${path.relative(repoRoot, full)}:${i + 1}: ${lines[i].trim()}`);
            }
          }
        }
      }
    }

    scan(transportDir);
    expect(violations, 'Found raw ws.send calls outside safeSend in connection-registry.ts (R27)').toEqual([]);
  });

  it('update_settings survives closed socket without throwing or unhandled rejection (R27)', async () => {
    // Mock socket that is closed / throws on send
    const closedWs: any = {
      readyState: 3, // CLOSED
      send: () => {
        throw new Error('WebSocket is not open: readyState 3 (CLOSED)');
      },
    };

    const dummyState: any = {
      settingsManager: {
        getSettingSchema: () => ({ type: 'string' }),
        set: () => {},
        get: () => 'val',
      },
    };

    const dummyCtx: any = {
      apiKeyHash: 'test-key',
      scopes: ['admin'],
      settingsManager: dummyState.settingsManager,
    };

    const updateMsg: any = {
      type: 'update_settings',
      id: 'test-msg-1',
      settings: { 'agent.name': 'test' },
    };

    // Today handleWsUpdateSettings calls raw ws.send() which throws
    // We expect it to complete cleanly using safeSend without throwing
    let threw = false;
    try {
      await handleWsUpdateSettings(updateMsg, closedWs, dummyState, dummyCtx);
    } catch (err) {
      threw = true;
    }

    expect(threw, 'handleWsUpdateSettings must not throw on closed socket').toBe(false);
  });

  it('dispatcher catch-all safeSends typed error frame with clientMsgId on unexpected handler errors', async () => {
    const { handleConnection } = await import('../ws-handlers.js');
    const { createConnectionRegistry } = await import('../connection-registry.js');
    const { ServerSessionManager } = await import('../../http/session-store.js');
    const { MemoryPersistenceBackend } = await import('../../../domain/sessions/session-store.js');
    const { generateApiKey } = await import('../../auth/auth.js');
    const os = await import('node:os');

    const rawKeyPath = path.join(os.tmpdir(), `seepient-ws-fence-keys-${Date.now()}.json`);
    process.env.SEEPIENT_API_KEYS_FILE = rawKeyPath;
    const rawKey = generateApiKey(['agent:run', 'agent:read', 'admin'], { filePath: rawKeyPath }).rawKey!;

    const sent: any[] = [];
    const handlers = new Map<string, (...args: any[]) => void>();
    const ws: any = {
      readyState: 1,
      send: (data: string) => sent.push(JSON.parse(data)),
      on: (ev: string, cb: any) => handlers.set(ev, cb),
      close: () => {},
      ping: () => {},
    };

    const dummySettingsManager: any = {
      getSettingSchema: () => {
        throw new Error('Exploding settings manager');
      },
    };

    const ctx: any = {
      registry: createConnectionRegistry(),
      sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
      streamText: () => {},
      listModels: () => ({}),
      listSkills: () => [],
      settingsHandlerContext: {
        settingsManager: dummySettingsManager,
        apiKeyHash: 'fence-test',
        scopes: ['admin'],
      },
    };

    handleConnection(ws, { headers: { authorization: `Bearer ${rawKey}` } } as any, ctx);
    const onMessage = handlers.get('message')!;

    // Send get_settings which calls dummySettingsManager and throws
    onMessage(Buffer.from(JSON.stringify({
      type: 'get_settings',
      id: 'req-fence-42',
    })));

    // Allow async tick to complete
    await new Promise((r) => setTimeout(r, 20));

    const errorFrame = sent.find((m) => m.type === 'error' && m.clientMsgId === 'req-fence-42');
    expect(errorFrame).toBeDefined();
    expect(errorFrame?.code).toBe('INTERNAL_ERROR');
    expect(errorFrame?.clientMsgId).toBe('req-fence-42');

    try {
      fs.unlinkSync(rawKeyPath);
    } catch {}
  });

  it('unknown message type echoes clientMsgId in error frame', async () => {
    const { handleConnection } = await import('../ws-handlers.js');
    const { createConnectionRegistry } = await import('../connection-registry.js');
    const { ServerSessionManager } = await import('../../http/session-store.js');
    const { MemoryPersistenceBackend } = await import('../../../domain/sessions/session-store.js');
    const { generateApiKey } = await import('../../auth/auth.js');
    const os = await import('node:os');

    const rawKeyPath = path.join(os.tmpdir(), `seepient-ws-fence-keys2-${Date.now()}.json`);
    process.env.SEEPIENT_API_KEYS_FILE = rawKeyPath;
    const rawKey = generateApiKey(['agent:run'], { filePath: rawKeyPath }).rawKey!;

    const sent: any[] = [];
    const handlers = new Map<string, (...args: any[]) => void>();
    const ws: any = {
      readyState: 1,
      send: (data: string) => sent.push(JSON.parse(data)),
      on: (ev: string, cb: any) => handlers.set(ev, cb),
      close: () => {},
      ping: () => {},
    };

    const ctx: any = {
      registry: createConnectionRegistry(),
      sessionManager: new ServerSessionManager({ backend: new MemoryPersistenceBackend() }),
      streamText: () => {},
      listModels: () => ({}),
      listSkills: () => [],
    };

    handleConnection(ws, { headers: { authorization: `Bearer ${rawKey}` } } as any, ctx);
    const onMessage = handlers.get('message')!;

    onMessage(Buffer.from(JSON.stringify({
      type: 'non_existent_message_type',
      id: 'unknown-type-msg-123',
    })));

    await new Promise((r) => setTimeout(r, 20));

    const err = sent.find((m) => m.clientMsgId === 'unknown-type-msg-123');
    expect(err).toBeDefined();
    expect(err?.code).toBe('UNKNOWN_MESSAGE_TYPE');
    expect(err?.clientMsgId).toBe('unknown-type-msg-123');

    try {
      fs.unlinkSync(rawKeyPath);
    } catch {}
  });

  it('standalone registerProcessGuards handles unhandledRejection without exiting process', async () => {
    const { registerProcessGuards } = await import('../../http/standalone.js');
    expect(typeof registerProcessGuards).toBe('function');

    let written = '';
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => {
      written += String(chunk);
      return true;
    }) as any;

    try {
      registerProcessGuards();
      process.emit('unhandledRejection' as any, new Error('Synthetic unhandled test error'));
      expect(written).toContain('process_unhandled_rejection');
      expect(written).toContain('Synthetic unhandled test error');
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
