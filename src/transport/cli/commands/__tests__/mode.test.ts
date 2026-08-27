import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modeHandler } from '../mode.js';
import { Agent } from '../../agent.js';
import { createMockRuntime } from '../../../../domain/__tests__/test-doubles.js';
import { createSnapshotStore } from '../../../../foundations/hashline/snapshot-store.js';
import { SettingsManager } from '../../../../domain/settings/settings-manager.js';
import * as settingsModule from '../settings.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seepient-mode-cmd-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeAgent(): Agent {
  const fakeRuntime = createMockRuntime([{ content: '' }]);
  const agent = new Agent(
    fakeRuntime,
    'model',
    { snapshotStore: createSnapshotStore() },
    'system prompt',
    null,
    'openai',
  );
  return agent;
}

describe('/mode command', () => {
  it('lists consent modes when called with no arguments', async () => {
    const agent = makeAgent();
    const res = await modeHandler({ agent, args: '', config: {} });
    expect(res.output).toContain('Consent Modes:');
    expect(res.output).toContain('ask-everything');
    expect(res.output).toContain('edit-enabled');
    expect(res.output).toContain('autonomous');
  });

  it('rejects invalid mode names', async () => {
    const agent = makeAgent();
    const res = await modeHandler({ agent, args: 'invalid-mode', config: {} });
    expect(res.output).toContain('Invalid mode: "invalid-mode"');
  });

  it('switches to edit-enabled without warning', async () => {
    const agent = makeAgent();
    const mockSetConsentMode = vi.fn();
    agent.setConsentMode = mockSetConsentMode;

    const mgr = new SettingsManager({
      config: {},
      projectConfigPath: join(dir, 'config.json'),
      globalConfigPath: join(dir, 'config.json'),
    });
    vi.spyOn(settingsModule, 'createSettingsManager').mockReturnValue(mgr);

    const res = await modeHandler({ agent, args: 'edit-enabled', config: {} });
    expect(res.output).toContain('Switched consent mode to: edit-enabled');
    expect(mockSetConsentMode).toHaveBeenCalledWith('edit-enabled');
    expect(mgr.get('permissions.consentMode').value).toBe('edit-enabled');
  });

  it('shows warning when switching to autonomous while unwarned and --confirm is not passed', async () => {
    const agent = makeAgent();
    const mockSetConsentMode = vi.fn();
    agent.setConsentMode = mockSetConsentMode;

    const mgr = new SettingsManager({
      config: {},
      projectConfigPath: join(dir, 'config.json'),
      globalConfigPath: join(dir, 'config.json'),
    });
    vi.spyOn(settingsModule, 'createSettingsManager').mockReturnValue(mgr);

    const res = await modeHandler({ agent, args: 'autonomous', config: {} });
    expect(res.output).toContain('Autonomous Mode Warning');
    expect(res.output).toContain('/mode autonomous --confirm');
    expect(mockSetConsentMode).not.toHaveBeenCalled();
    expect(mgr.get('permissions.consentMode').value).toBe('edit-enabled');
  });

  it('enables autonomous and sets autonomousWarned when --confirm is passed', async () => {
    const agent = makeAgent();
    const mockSetConsentMode = vi.fn();
    agent.setConsentMode = mockSetConsentMode;

    const mgr = new SettingsManager({
      config: {},
      projectConfigPath: join(dir, 'config.json'),
      globalConfigPath: join(dir, 'config.json'),
    });
    vi.spyOn(settingsModule, 'createSettingsManager').mockReturnValue(mgr);

    const res = await modeHandler({ agent, args: 'autonomous --confirm', config: {} });
    expect(res.output).toContain('Switched consent mode to: autonomous');
    expect(mockSetConsentMode).toHaveBeenCalledWith('autonomous');
    expect(mgr.get('permissions.consentMode').value).toBe('autonomous');
    expect(mgr.get('permissions.autonomousWarned').value).toBe(true);
  });

  it('switches to autonomous without warning if already warned', async () => {
    const agent = makeAgent();
    const mockSetConsentMode = vi.fn();
    agent.setConsentMode = mockSetConsentMode;

    const mgr = new SettingsManager({
      config: { permissions: { autonomousWarned: true } },
      projectConfigPath: join(dir, 'config.json'),
      globalConfigPath: join(dir, 'config.json'),
    });
    vi.spyOn(settingsModule, 'createSettingsManager').mockReturnValue(mgr);

    const res = await modeHandler({ agent, args: 'autonomous', config: {} });
    expect(res.output).toContain('Switched consent mode to: autonomous');
    expect(mockSetConsentMode).toHaveBeenCalledWith('autonomous');
    expect(mgr.get('permissions.consentMode').value).toBe('autonomous');
  });
});
