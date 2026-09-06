/**
 * Minimal settings-manager surface the server transport consumes.
 *
 * Foundations may not import Domain, so `RunSeepientServerOptions`
 * references this structural contract instead of the concrete
 * `SettingsManager` class; the concrete class satisfies it structurally.
 */

export interface SettingsValueLike {
  value: unknown;
  origin: string;
  masked: boolean;
}

export interface SettingsEntryLike extends SettingsValueLike {
  dotKey: string;
  category: string;
  restartRequired: boolean;
  label: string;
}

export interface SettingsManagerLike {
  get(dotKey: string): SettingsValueLike;
  listByCategory(): Record<string, SettingsEntryLike[]>;
  set(dotKey: string, rawValue: unknown): Promise<void>;
}
