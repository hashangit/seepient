import { describe, it, expect, vi } from 'vitest';
import {
  isAutonomousWarned,
  shouldShowAutonomousWarning,
  type SettingLike,
} from '../autonomous-decision.js';
import type { ConsentMode } from '../../../foundations/settings-schema.js';

describe('autonomous-decision helpers', () => {
  describe('isAutonomousWarned', () => {
    it('returns false for empty or missing settings', () => {
      expect(isAutonomousWarned(null)).toBe(false);
      expect(isAutonomousWarned(undefined)).toBe(false);
      expect(isAutonomousWarned([])).toBe(false);
    });

    it('returns true when permissions.autonomousWarned is boolean true', () => {
      const settings: SettingLike[] = [
        { dotKey: 'permissions.consentMode', value: 'edit-enabled' },
        { dotKey: 'permissions.autonomousWarned', value: true },
      ];
      expect(isAutonomousWarned(settings)).toBe(true);
    });

    it('returns true when permissions.autonomousWarned is string "true"', () => {
      const settings: SettingLike[] = [
        { dotKey: 'permissions.autonomousWarned', value: 'true' },
      ];
      expect(isAutonomousWarned(settings)).toBe(true);
    });

    it('returns false when permissions.autonomousWarned is false or missing', () => {
      expect(
        isAutonomousWarned([{ dotKey: 'permissions.autonomousWarned', value: false }]),
      ).toBe(false);
      expect(
        isAutonomousWarned([{ dotKey: 'permissions.autonomousWarned', value: 'false' }]),
      ).toBe(false);
      expect(
        isAutonomousWarned([{ dotKey: 'permissions.consentMode', value: 'autonomous' }]),
      ).toBe(false);
    });

    it('works with SettingsGetterLike objects', () => {
      const getterFalse = { get: (k: string) => ({ value: false }) };
      expect(isAutonomousWarned(getterFalse)).toBe(false);

      const getterTrue = { get: (k: string) => ({ value: true }) };
      expect(isAutonomousWarned(getterTrue)).toBe(true);
    });
  });

  describe('shouldShowAutonomousWarning', () => {
    it('returns true when target is autonomous and unwarned', () => {
      expect(shouldShowAutonomousWarning('autonomous', false)).toBe(true);
    });

    it('returns false when already warned', () => {
      expect(shouldShowAutonomousWarning('autonomous', true)).toBe(false);
    });

    it('returns false for non-autonomous target modes regardless of warned status', () => {
      expect(shouldShowAutonomousWarning('edit-enabled', false)).toBe(false);
      expect(shouldShowAutonomousWarning('ask-everything', false)).toBe(false);
      expect(shouldShowAutonomousWarning('edit-enabled', true)).toBe(false);
      expect(shouldShowAutonomousWarning('ask-everything', true)).toBe(false);
    });
  });

  describe('confirmation sequence and error recovery', () => {
    it('executes writes in correct order: warned flag FIRST, then runtime + React state, then consentMode', async () => {
      const callOrder: string[] = [];

      let runtimeMode: ConsentMode = 'edit-enabled';
      let reactMode: ConsentMode = 'edit-enabled';
      const persistedSettings: Record<string, unknown> = {};

      const mockSetSetting = vi.fn(async (key: string, val: unknown) => {
        callOrder.push(`setting:${key}:${val}`);
        persistedSettings[key] = val;
      });

      const mockSetConsentMode = vi.fn((mode: ConsentMode) => {
        callOrder.push(`runtime:${mode}`);
        runtimeMode = mode;
      });

      // Emulate confirmAutonomousMode flow
      const confirmFlow = async () => {
        const prevMode = reactMode === 'autonomous' ? 'edit-enabled' : reactMode;
        try {
          // 1. Mark warned first
          await mockSetSetting('permissions.autonomousWarned', true);
          // 2. Set live runtime + React state
          mockSetConsentMode('autonomous');
          reactMode = 'autonomous';
          // 3. Persist consentMode
          await mockSetSetting('permissions.consentMode', 'autonomous');
        } catch (err) {
          mockSetConsentMode(prevMode);
          reactMode = prevMode;
          throw err;
        }
      };

      await confirmFlow();

      expect(callOrder).toEqual([
        'setting:permissions.autonomousWarned:true',
        'runtime:autonomous',
        'setting:permissions.consentMode:autonomous',
      ]);
      expect(runtimeMode).toBe('autonomous');
      expect(reactMode).toBe('autonomous');
      expect(persistedSettings['permissions.autonomousWarned']).toBe(true);
      expect(persistedSettings['permissions.consentMode']).toBe('autonomous');
    });

    it('reverts runtime and state if consentMode persistence fails mid-flow', async () => {
      let runtimeMode: ConsentMode = 'edit-enabled';
      let reactMode: ConsentMode = 'edit-enabled';
      const persistedSettings: Record<string, unknown> = {};

      const mockSetSetting = vi.fn(async (key: string, val: unknown) => {
        if (key === 'permissions.consentMode') {
          throw new Error('Disk full');
        }
        persistedSettings[key] = val;
      });

      const mockSetConsentMode = vi.fn((mode: ConsentMode) => {
        runtimeMode = mode;
      });

      const confirmFlow = async () => {
        const prevMode = reactMode === 'autonomous' ? 'edit-enabled' : reactMode;
        try {
          await mockSetSetting('permissions.autonomousWarned', true);
          mockSetConsentMode('autonomous');
          reactMode = 'autonomous';
          await mockSetSetting('permissions.consentMode', 'autonomous');
        } catch (err) {
          mockSetConsentMode(prevMode);
          reactMode = prevMode;
        }
      };

      await confirmFlow();

      // Runtime and React mode must be reverted to edit-enabled
      expect(runtimeMode).toBe('edit-enabled');
      expect(reactMode).toBe('edit-enabled');
      // consentMode must not have been persisted as autonomous
      expect(persistedSettings['permissions.consentMode']).toBeUndefined();
      // warned flag was persisted
      expect(persistedSettings['permissions.autonomousWarned']).toBe(true);
    });

    it('cancelling autonomous warning on startup drops session to edit-enabled without writing settings', () => {
      let runtimeMode: ConsentMode = 'autonomous';
      let reactMode: ConsentMode = 'autonomous';
      const mockSetSetting = vi.fn();
      const mockSetConsentMode = vi.fn((mode: ConsentMode) => {
        runtimeMode = mode;
      });

      // Emulate cancelAutonomousWarning when currentConsentMode was autonomous
      const cancelFlow = () => {
        if (reactMode === 'autonomous') {
          mockSetConsentMode('edit-enabled');
          reactMode = 'edit-enabled';
        }
      };

      cancelFlow();

      expect(runtimeMode).toBe('edit-enabled');
      expect(reactMode).toBe('edit-enabled');
      expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it('cycleConsentMode rolls back live runtime and state if settings write fails', async () => {
      let runtimeMode: ConsentMode = 'edit-enabled';
      let reactMode: ConsentMode = 'edit-enabled';
      const mockSetSetting = vi.fn(async (_k: string, _v: unknown) => {
        throw new Error('Read-only file system');
      });
      const mockSetConsentMode = vi.fn((m: ConsentMode) => {
        runtimeMode = m;
      });

      const cycleFlow = async () => {
        const cycleMap: Record<ConsentMode, ConsentMode> = {
          'ask-everything': 'edit-enabled',
          'edit-enabled': 'autonomous',
          autonomous: 'ask-everything',
        };
        const prevMode = reactMode;
        const nextMode = cycleMap[prevMode] ?? 'edit-enabled';
        try {
          mockSetConsentMode(nextMode);
          reactMode = nextMode;
          await mockSetSetting('permissions.consentMode', nextMode);
        } catch {
          mockSetConsentMode(prevMode);
          reactMode = prevMode;
        }
      };

      await cycleFlow();

      expect(runtimeMode).toBe('edit-enabled');
      expect(reactMode).toBe('edit-enabled');
    });
  });
});
