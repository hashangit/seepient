export const PLATFORMS: readonly string[];
export const REQUIRED_PACK_FILES: readonly string[];

export function assertNoCleanInPublishHooks(packageJson: {
  scripts?: Record<string, string>;
}): void;

export function assertNotPlaceholder(manifest: {
  placeholder?: boolean;
}): void;

export function stagePlaceholderHelpers(projectRoot: string): {
  staged: boolean;
  manifestPath: string;
};

export function assertPackFiles(files: readonly string[]): void;

export function verifyPack(projectRoot?: string, opts?: Record<string, unknown>): {
  success: boolean;
  count: number;
};
