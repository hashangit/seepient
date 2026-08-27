import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderManagerApi, ManagerState } from '../../../transport/cli/provider-manager-api.js';
import type { SettingsAdapter } from '../setup-wizard.js';

let resolveExit: () => void;
let waitUntilExitPromise: Promise<void>;
const unmountMock = vi.fn();

vi.mock('ink', () => ({
  render: vi.fn((_tree: any, _options: any) => {
    return {
      unmount: unmountMock,
      waitUntilExit: vi.fn(() => waitUntilExitPromise),
      rerender: vi.fn(),
      cleanup: vi.fn(),
      clear: vi.fn(),
    };
  }),
}));

describe('runSetupWizard wrapper (Fix 2 regression)', () => {
  beforeEach(() => {
    unmountMock.mockClear();
    waitUntilExitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
  });

  it('settles when Ink unmounts without onFinish or onExitSetup callbacks firing', async () => {
    const { runSetupWizard } = await import('../setup-wizard.js');

    const fakeState: ManagerState = {
      revision: 1,
      accounts: [],
      assignments: {} as any,
      models: [],
      purposes: [],
    };

    const fakeApi: ProviderManagerApi = {
      getState: async () => fakeState,
      saveAccount: async () => ({ ok: true, state: fakeState }),
      deleteAccount: async () => ({ ok: true, state: fakeState }),
      setAssignment: async () => ({ ok: true, state: fakeState }),
      clearAssignment: async () => ({ ok: true, state: fakeState }),
      resolvePreview: async () => ({
        selectedTarget: { providerAccount: 'acme', model: 'test' },
        via: 'fallback-chain',
        failureTargets: [],
      }),
      probeAccount: async () => ({ accountId: 'acme', authValid: true }),
      refreshModels: async () => ({ ok: true, discovered: [], state: fakeState }),
      switchSessionModel: () => {},
      signInWithProvider: async () => ({ ok: true, state: fakeState }),
      completeOAuthSignIn: async () => ({ ok: true, state: fakeState }),
      logoutAccount: async () => ({ ok: true, state: fakeState }),
      getAvailableOAuthFlows: async () => [],
    };

    const fakeSettings: SettingsAdapter = {
      get: async () => undefined,
      set: vi.fn(),
    };

    const wizardPromise = runSetupWizard({
      buildApi: () => fakeApi,
      buildSettings: () => fakeSettings,
    });

    // Simulate Ctrl+C / external unmount by resolving the exit promise directly,
    // WITHOUT invoking onFinish or onExitSetup callbacks.
    resolveExit();

    const timeout = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('runSetupWizard hung without callbacks')), 1000)
    );

    await expect(Promise.race([wizardPromise, timeout])).resolves.toBeUndefined();
  });
});
