import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveRuntimeFlags } from '../bootstrap.js';

describe('CLI Bootstrap Runtime Flags (FR-019)', () => {
  it('asserts config.autoConfirm is false under --docker alone', () => {
    const flags = resolveRuntimeFlags({ docker: true });
    expect(flags.autoConfirm).toBe(false);
    expect(flags.consentMode).toBe('edit-enabled');
  });

  it('asserts config.autoConfirm is false under --headless alone', () => {
    const flags = resolveRuntimeFlags({ headless: true });
    expect(flags.autoConfirm).toBe(false);
    expect(flags.consentMode).toBe('edit-enabled');
  });

  it('asserts config.autoConfirm is true under --yes', () => {
    const flags = resolveRuntimeFlags({ yes: true });
    expect(flags.autoConfirm).toBe(true);
    expect(flags.consentMode).toBe('autonomous');
  });

  it('asserts config.autoConfirm is true under --docker when --yes is also passed', () => {
    const flags = resolveRuntimeFlags({ docker: true, yes: true });
    expect(flags.autoConfirm).toBe(true);
    expect(flags.consentMode).toBe('autonomous');
  });

  it('verifies documentation copy matches real behavior for container and headless execution', () => {
    const rootDir = path.resolve(__dirname, '../../../../');
    const readmeContent = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf-8');
    const cliRefContent = fs.readFileSync(path.join(rootDir, 'docs/cli/reference.md'), 'utf-8');

    // README table row
    expect(readmeContent).toContain(
      'denies un-predeclared actions; pass `--mode autonomous` or `--yes` for unattended runs',
    );
    // README container explanation
    expect(readmeContent).toContain(
      'Headless execution denies un-predeclared actions with typed remediation; pass `--mode autonomous` or `--yes` for unattended runs.',
    );
    // docs/cli/reference.md table row
    expect(cliRefContent).toContain(
      'denies un-predeclared actions; pass `--mode autonomous` or `--yes` for unattended runs',
    );
  });
});
