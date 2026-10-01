import { describe, it, expect, vi } from 'vitest';
import { applyEnvOverrides } from '../../../foundations/config.js';
import { resolveRuntimeFlags } from '../bootstrap.js';

describe('unrecognized SEEPIENT_CONSENT_MODE warning (FR-006)', () => {
  it('warns loudly with substring Unrecognized SEEPIENT_CONSENT_MODE when invalid mode is supplied', () => {
    const originalEnv = process.env.SEEPIENT_CONSENT_MODE;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      process.env.SEEPIENT_CONSENT_MODE = 'bogus-mode';
      applyEnvOverrides({});

      expect(warnSpy).toHaveBeenCalled();
      const warnCalls = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(warnCalls).toContain('Unrecognized SEEPIENT_CONSENT_MODE');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.SEEPIENT_CONSENT_MODE;
      } else {
        process.env.SEEPIENT_CONSENT_MODE = originalEnv;
      }
      warnSpy.mockRestore();
    }
  });

  it('warns with substring Unrecognized consent mode when baseConfig.consentMode is invalid', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const originalEnv = process.env.SEEPIENT_CONSENT_MODE;
    delete process.env.SEEPIENT_CONSENT_MODE;
    try {
      const { consentMode } = resolveRuntimeFlags({}, { consentMode: 'invalid-mode' });
      expect(consentMode).toBe('edit-enabled');
      expect(warnSpy).toHaveBeenCalled();
      const warnCalls = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(warnCalls).toContain('Unrecognized consent mode "invalid-mode"');
    } finally {
      if (originalEnv !== undefined) {
        process.env.SEEPIENT_CONSENT_MODE = originalEnv;
      }
      warnSpy.mockRestore();
    }
  });
});
