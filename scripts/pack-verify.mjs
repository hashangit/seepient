#!/usr/bin/env node
/**
 * Pack Verification Gate (Spec 021-2 / FR-001)
 *
 * Enforces:
 * 1. Static hook assertion: No publish-time hook (prepublishOnly, prepack)
 *    may reference `clean` or `rm -rf dist` (which would wipe staged binaries).
 * 2. Helper staging: Staged placeholder binaries and manifest when real binaries absent.
 * 3. Dry-run pack verification: `pnpm pack --dry-run --json` contains manifest.json
 *    and all four platform binaries.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

export const REQUIRED_PACK_FILES = [
  "dist/native-fs-commit/manifest.json",
  ...PLATFORMS.map((p) => `dist/native-fs-commit/${p}/seepient-fs-commit`),
];

/**
 * Asserts that no publish-time hook runs `clean` or `rm -rf dist`.
 * Throws an error if any violation is found.
 */
export function assertNoCleanInPublishHooks(packageJson) {
  const scripts = packageJson.scripts || {};
  const dangerousHooks = ["prepublishOnly", "prepack", "prepare"];

  for (const hook of dangerousHooks) {
    const script = scripts[hook];
    if (typeof script === "string") {
      if (/\bclean\b/.test(script) || /rm\s+-rf\s+dist/.test(script)) {
        throw new Error(
          `Static hook assertion failed: "${hook}" script must not reference "clean" or "rm -rf dist": found "${script}"`,
        );
      }
    }
  }
}

/**
 * Asserts that the manifest does not carry the placeholder: true marker.
 * Throws if the package contains placeholder binaries.
 */
export function assertNotPlaceholder(manifest) {
  if (manifest && manifest.placeholder === true) {
    throw new Error("Refusing to publish package containing placeholder native binaries!");
  }
}

/**
 * Stages placeholder native helper binaries and manifest.json if any are missing.
 * Mirrors release.yml:103-134.
 */
export function stagePlaceholderHelpers(projectRoot) {
  const root = path.join(projectRoot, "dist/native-fs-commit");
  fs.mkdirSync(root, { recursive: true });

  let anyPlaceholderCreated = false;
  const binaries = {};
  for (const platform of PLATFORMS) {
    const platformDir = path.join(root, platform);
    fs.mkdirSync(platformDir, { recursive: true });
    const binPath = path.join(platformDir, "seepient-fs-commit");

    if (!fs.existsSync(binPath) || fs.statSync(binPath).size === 0) {
      anyPlaceholderCreated = true;
      // Create a dummy executable placeholder for pack verification
      fs.writeFileSync(binPath, "#!/bin/sh\necho seepient-fs-commit-placeholder\n", {
        mode: 0o755,
      });
    }

    const bytes = fs.readFileSync(binPath);
    if (bytes.toString("utf8").includes("seepient-fs-commit-placeholder")) {
      anyPlaceholderCreated = true;
    }
    binaries[platform] = {
      path: `${platform}/seepient-fs-commit`,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  }

  const manifestPath = path.join(root, "manifest.json");
  if (!fs.existsSync(manifestPath) || anyPlaceholderCreated) {
    const manifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      ...(anyPlaceholderCreated ? { placeholder: true } : {}),
      binaries,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }

  return {
    staged: anyPlaceholderCreated,
    manifestPath,
  };
}

/**
 * Asserts that the pack dry-run output contains all required files.
 */
export function assertPackFiles(packFileList) {
  const normalized = new Set(packFileList.map((f) => f.replace(/^\.\//, "")));
  const missing = [];

  for (const req of REQUIRED_PACK_FILES) {
    if (!normalized.has(req)) {
      missing.push(req);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Pack contents assertion failed: missing required files in tarball:\n  - ${missing.join("\n  - ")}`,
    );
  }
}

/**
 * Runs the full verification pipeline.
 */
export function verifyPack(projectRoot = process.cwd(), opts = {}) {
  const pkgPath = path.join(projectRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  // 1. Static assertion on publish-time hooks
  assertNoCleanInPublishHooks(pkg);

  // 2. Stage placeholders if missing
  stagePlaceholderHelpers(projectRoot);

  // 3. Dry-run pack
  let stdout;
  try {
    stdout = execSync("pnpm pack --dry-run --json", {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (err) {
    // Fallback to npm pack if pnpm fails
    stdout = execSync("npm pack --dry-run --json", {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
  }

  // 4. Parse pack output and check files
  const parsed = JSON.parse(stdout);
  const files = Array.isArray(parsed) ? parsed[0]?.files : parsed?.files;
  if (!Array.isArray(files)) {
    throw new Error(`Unexpected pack json structure: missing files array`);
  }

  const filePaths = files.map((f) => (typeof f === "string" ? f : f.path));
  assertPackFiles(filePaths);

  return { success: true, count: filePaths.length };
}

// Execute when invoked directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const result = verifyPack(process.cwd());
    console.log(`✓ Pack verification passed: all native helpers and manifest present (${result.count} files).`);
    process.exit(0);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
