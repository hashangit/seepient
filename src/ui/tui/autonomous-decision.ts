/**
 * Autonomous Mode Warning Decision Helpers (spec 017, T030).
 *
 * Single decision point determining whether an autonomous mode transition
 * requires displaying the high-risk confirmation overlay.
 */

import type { ConsentMode } from '../../foundations/settings-schema.js';

export interface SettingLike {
  dotKey: string;
  value: unknown;
}

export interface SettingsGetterLike {
  get(dotKey: string): { value: unknown };
}

/**
 * Checks whether the autonomous mode warning has been acknowledged.
 */
export function isAutonomousWarned(
  settings: SettingLike[] | SettingsGetterLike | undefined | null,
): boolean {
  if (!settings) return false;
  if (Array.isArray(settings)) {
    const entry = settings.find((s) => s.dotKey === 'permissions.autonomousWarned');
    return entry?.value === true || entry?.value === 'true';
  }
  const entry = settings.get('permissions.autonomousWarned');
  return entry?.value === true || entry?.value === 'true';
}

/**
 * Determines if the autonomous warning overlay must be shown.
 *
 * Returns true if the target mode is autonomous and the warned flag is false.
 */
export function shouldShowAutonomousWarning(
  targetMode: ConsentMode,
  isWarned: boolean,
): boolean {
  if (targetMode !== 'autonomous') return false;
  if (isWarned) return false;
  return true;
}
