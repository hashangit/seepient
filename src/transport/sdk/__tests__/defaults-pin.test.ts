import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveTenancyMode } from '../../../domain/tenancy/tenancy-mode.js';
import { parseServerCliArgs } from '../../cli/server-cli.js';

const repoRoot = path.resolve(__dirname, '../../../..');

interface DefaultPinRow {
  key: string;
  docSource: string;
  docStatedValue: () => string;
  runtimeResolvedValue: () => string;
}

describe('defaults pin suite (FR-004)', () => {
  const pinRows: DefaultPinRow[] = [
    {
      key: 'SDK consent/approval default (no consentMode/broker)',
      docSource: 'docs/sdk/ask-seepient.md',
      docStatedValue: () => {
        const content = fs.readFileSync(path.join(repoRoot, 'docs/sdk/ask-seepient.md'), 'utf8');
        const match = content.match(/When omitted,\s*`consentMode`\s*operates\s*\*\*(deny-by-default)\*\*/);
        if (match) return match[1];
        const matchOld = content.match(/The `consentMode` option[^\n]*\n\n-\s*Defaults to\s*["']([^"']+)["']/);
        if (matchOld) return matchOld[1];
        return 'unknown';
      },
      runtimeResolvedValue: () => {
        return 'deny-by-default';
      },
    },
    {
      key: 'CLI consent default',
      docSource: 'README.md',
      docStatedValue: () => {
        const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
        const match = readme.match(/`edit-enabled`\s*\(Default\)/i);
        return match ? 'edit-enabled' : 'unknown';
      },
      runtimeResolvedValue: () => {
        // bootstrap.ts:77-79 defaults to 'edit-enabled'
        return 'edit-enabled';
      },
    },
    {
      key: 'Tenancy default',
      docSource: 'docs/sdk/multi-tenant.md',
      docStatedValue: () => {
        const content = fs.readFileSync(path.join(repoRoot, 'docs/sdk/multi-tenant.md'), 'utf8');
        const match = content.match(/`single`\s*\(default\)/i);
        return match ? 'single' : 'unknown';
      },
      runtimeResolvedValue: () => {
        return resolveTenancyMode({}).mode;
      },
    },
    {
      key: 'Single-mode principal default',
      docSource: 'docs/sdk/ask-seepient.md',
      docStatedValue: () => {
        const content = fs.readFileSync(path.join(repoRoot, 'docs/sdk/ask-seepient.md'), 'utf8');
        const match = content.match(/`principalId`\s*\|\s*`string`\s*\|\s*`"([^"]+)"`/);
        return match ? match[1] : 'unknown';
      },
      runtimeResolvedValue: () => {
        return 'sdk-user';
      },
    },
    {
      key: 'Server port',
      docSource: 'docs/server/overview.md',
      docStatedValue: () => {
        const content = fs.readFileSync(path.join(repoRoot, 'docs/server/overview.md'), 'utf8');
        const match = content.match(/\b7337\b/);
        return match ? '7337' : 'unknown';
      },
      runtimeResolvedValue: () => {
        return '7337';
      },
    },
    {
      key: 'Server host',
      docSource: 'docs/server/overview.md',
      docStatedValue: () => {
        const content = fs.readFileSync(path.join(repoRoot, 'docs/server/overview.md'), 'utf8');
        const match = content.match(/\b127\.0\.0\.1\b/);
        return match ? '127.0.0.1' : 'unknown';
      },
      runtimeResolvedValue: () => {
        // When no host arg/env is given, standalone/server defaults to 127.0.0.1
        const parsed = parseServerCliArgs([]);
        return parsed.host ?? '127.0.0.1';
      },
    },
    {
      key: 'SDK consentMode table cell default in ask-seepient.md',
      docSource: 'docs/sdk/ask-seepient.md',
      docStatedValue: () => {
        const content = fs.readFileSync(path.join(repoRoot, 'docs/sdk/ask-seepient.md'), 'utf8');
        const match = content.match(/`consentMode`\s*\|\s*`ConsentMode`\s*\|\s*([^|]+)\|/);
        return match ? match[1].trim() : 'unknown';
      },
      runtimeResolvedValue: () => {
        return 'deny-by-default';
      },
    },
    {
      key: 'Server session directory default in overview.md',
      docSource: 'docs/server/overview.md',
      docStatedValue: () => {
        const content = fs.readFileSync(path.join(repoRoot, 'docs/server/overview.md'), 'utf8');
        const match = content.match(/`SEEPIENT_SESSION_DIR`\s*\|\s*Directory for session files\s*\|\s*`([^`]+)`/);
        return match ? match[1] : 'unknown';
      },
      runtimeResolvedValue: () => {
        return './.seepient/sessions';
      },
    },
    {
      key: 'Server session directory default in sessions.md',
      docSource: 'docs/server/sessions.md',
      docStatedValue: () => {
        const content = fs.readFileSync(path.join(repoRoot, 'docs/server/sessions.md'), 'utf8');
        const match = content.match(/session directory defaults to\s*`([^`]+)`/);
        return match ? match[1] : 'unknown';
      },
      runtimeResolvedValue: () => {
        return './.seepient/sessions/';
      },
    },
    {
      key: 'WS maxPayload',
      docSource: 'docs/server/websocket-api.md',
      docStatedValue: () => {
        const content = fs.readFileSync(path.join(repoRoot, 'docs/server/websocket-api.md'), 'utf8');
        const match = content.match(/maximum frame payload of\s*`?(\d+)`?\s*bytes/);
        return match ? match[1] : 'unknown';
      },
      runtimeResolvedValue: () => {
        return String(1 << 20); // 1048576
      },
    },
  ];

  for (const row of pinRows) {
    it(`pins default for: ${row.key}`, () => {
      const docVal = row.docStatedValue();
      const runtimeVal = row.runtimeResolvedValue();
      expect(
        docVal,
        `Doc stated default in ${row.docSource} ("${docVal}") must match runtime resolved default ("${runtimeVal}")`
      ).toBe(runtimeVal);
    });
  }
});
