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

export function verifyPack(projectRoot?: string, opts?: { core?: boolean; allowPlaceholder?: boolean }): {
  success: boolean;
  files?: number;
  weightMb?: number;
  installedCount?: number;
};

export function assertNoWorkspaceSpecifiers(manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }, label: string): void;

export function assertNoDuplicatedEngine(rootDist: string, coreDist: string): string[];

export function assertReleaseWorkflowInvariants(repoRoot: string): void;

export function measureCoreInstallWeight(tarballPath: string): { mb: number; installed: string[] };

export function readTarballManifest(tarballPath: string): Record<string, unknown>;

export const CORE_WEIGHT_BUDGET_MB: number;
