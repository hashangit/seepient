#!/usr/bin/env node
/**
 * Pack Verification Gate (Spec 021-2 / FR-001; parameterized per package for
 * the 027 split).
 *
 * Root package (default): static hook assertion, native-helper staging,
 * pack contents, placeholder refusal, no-`workspace:` specifiers, B-3
 * no-duplicated-engine (forwarding shims whitelisted), release.yml
 * invariant greps.
 *
 * Core package (`--core`): dist-only manifest check (script-free,
 * publishConfig.access), no-`workspace:` specifiers, clean-install WEIGHT
 * BUDGET (≤ 150 MB unpacked, measured MB logged), banned-names assert on
 * the installed tree.
 *
 * The `npm pack` fallback is DELETED (spec 027 E12): raw npm pack ships
 * literal `workspace:^` — if `pnpm pack` fails, fail loudly.
 */

import fs from "node:fs";
import path, { join } from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

export const REQUIRED_PACK_FILES = [
  "dist/native-fs-commit/manifest.json",
  ...PLATFORMS.map((p) => `dist/native-fs-commit/${p}/seepient-fs-commit`),
];

/**
 * Contracts/package-boundary.md §2 — the packages banned BY NAME from the
 * core install closure. The provider-SDK majors (openai, @google/genai,
 * @anthropic-ai/sdk) and their own runtime deps (ws, web-streams-polyfill)
 * are pi-ai's legitimate nested pins — the contract explicitly names them as
 * the single source; they are governed by the one-version lockfile gate (B-4)
 * and the root manifest, not by this check.
 */
const BANNED_INSTALL_NAMES = new Set([
  "playwright", "playwright-core", "jsdom", "@mozilla/readability", "ink",
  "ink-select-input", "ink-spinner", "react", "inquirer", "figlet", "ora",
  "chalk", "terminal-link", "get-east-asian-width", "es-toolkit",
  "@modelcontextprotocol/sdk", "rxjs", "@anthropic-ai/sandbox-runtime",
  "nodemailer", "gpt-tokenizer", "commander", "diff", "dotenv", "js-yaml",
]);

/** Path-preserving forwarding shims (D16) — the ONLY engine-named files allowed in root dist. */
const FORWARDING_SHIM_WHITELIST = new Set(["types.js", "types.d.ts"]);

export const CORE_WEIGHT_BUDGET_MB = 150;

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
  if (!manifest) {
    throw new Error(
      "Refusing to publish package without native binaries! Build with `pnpm native:build` or use the release pipeline; placeholders never verify.",
    );
  }
  if (manifest.placeholder === true) {
    throw new Error("Refusing to publish package containing placeholder native binaries!");
  }
}

/**
 * Stages placeholder native helper binaries and manifest.json if any are missing.
 * Mirrors release.yml staging step (full package only — core never ships them).
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

  return { staged: anyPlaceholderCreated, manifestPath };
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

/** No `workspace:` protocol may survive into a packed manifest (E12). */
export function assertNoWorkspaceSpecifiers(manifest, label) {
  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}), ...(manifest.peerDependencies ?? {}) };
  const offenders = Object.entries(deps).filter(([, range]) => typeof range === "string" && range.includes("workspace:"));
  if (offenders.length > 0) {
    throw new Error(
      `${label}: packed manifest carries workspace: specifiers (raw npm pack would poison consumers): ${offenders.map(([k, v]) => `${k}@${v}`).join(", ")}`,
    );
  }
}

/** B-3: no compiled engine module duplicated into the root dist (forwarding shims whitelisted). */
export function assertNoDuplicatedEngine(rootDist, coreDist) {
  if (!fs.existsSync(coreDist) || !fs.existsSync(rootDist)) return [];
  const coreFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") || e.name.endsWith(".d.ts")) coreFiles.push(p);
    }
  })(coreDist);

  const duplicates = [];
  for (const cf of coreFiles) {
    const rel = path.relative(coreDist, cf); // e.g. foundations/types.js
    const rootCandidate = join(rootDist, rel);
    if (!fs.existsSync(rootCandidate)) continue;
    if (FORWARDING_SHIM_WHITELIST.has(path.basename(rel))) {
      // must be a real shim: a re-export, not a compiled engine copy
      const content = fs.readFileSync(rootCandidate, "utf8");
      if (!content.includes("seepient-core")) {
        duplicates.push(`${rel} (root copy is not a forwarding shim)`);
      }
      continue;
    }
    duplicates.push(rel);
  }
  if (duplicates.length > 0) {
    throw new Error(
      `B-3: engine modules compiled into BOTH artifacts (forwarding shims excepted):\n  - ${duplicates.join("\n  - ")}`,
    );
  }
  return [];
}

/** release.yml invariants, grepped in-repo (D18: no separate workflow-lint script). */
export function assertReleaseWorkflowInvariants(repoRoot) {
  const wfPath = path.join(repoRoot, ".github/workflows/release.yml");
  if (!fs.existsSync(wfPath)) {
    throw new Error("release.yml invariant check: .github/workflows/release.yml not found");
  }
  const wf = fs.readFileSync(wfPath, "utf8");
  const violations = [];
  // Core published BEFORE the root package.
  const corePublish = wf.indexOf("packages/core");
  const rootPublish = wf.indexOf('pnpm publish', Math.max(0, wf.indexOf("packages/core")));
  if (corePublish === -1 || rootPublish === -1) {
    violations.push("release.yml must publish packages/core via pnpm publish");
  }
  const firstCore = wf.indexOf("--no-git-checks");
  const firstRoot = wf.toLowerCase().includes("pnpm publish");
  if (!firstRoot) violations.push('release.yml must use "pnpm publish" (never raw "npm publish")');
  if (/(?<!p)npm publish/.test(wf)) violations.push('release.yml mentions raw "npm publish" — forbidden (workspace:^ poison)');
  // Explicit build before pack:verify. The core manifest is script-free
  // (E12 — pnpm publish --dry-run would run prepublishOnly), so
  // `pnpm --filter seepient-core build` has nothing to run; the root
  // `build:core` script is the build entry (P0-1).
  if (!/pnpm\s+run\s+build:core/.test(wf)) {
    violations.push('release.yml must run `pnpm run build:core` explicitly before pack:verify');
  }
  const buildIdx = wf.search(/pnpm\s+run\s+build:core/);
  const verifyIdx = wf.indexOf("pack:verify");
  if (buildIdx !== -1 && verifyIdx !== -1 && buildIdx > verifyIdx) {
    violations.push("release.yml: the explicit core build must appear BEFORE pack:verify");
  }
  // Core-first order: packages/core publish line precedes the root publish line.
  const coreLine = wf.split("\n").findIndex((l) => l.includes("packages/core") && l.includes("publish"));
  const rootLine = wf.split("\n").findIndex((l) => l.trim().startsWith("pnpm publish") || (l.includes("pnpm publish") && !l.includes("packages/core")));
  if (coreLine !== -1 && rootLine !== -1 && coreLine > rootLine) {
    violations.push("release.yml: packages/core must be published FIRST (lockstep order)");
  }
  if (wf.includes("--provenance") === false) {
    violations.push("release.yml: core publish should carry --provenance (supply-chain transparency)");
  }
  if (violations.length > 0) {
    throw new Error(`release.yml invariants failed:\n  - ${violations.join("\n  - ")}`);
  }
}

function packTarball(projectRoot) {
  // pnpm pack (NOT npm pack — the fallback ships literal workspace:^; fail loudly instead).
  const out = execSync("pnpm pack --json", { cwd: projectRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  const filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed?.filename;
  if (!filename) throw new Error(`Unexpected pnpm pack json: no filename`);
  return path.join(projectRoot, filename);
}

/** Clean-install the packed core tarball and return the unpacked MB of its closure. */
export function measureCoreInstallWeight(tarballPath) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "core-weight-"));
  try {
    execSync(`npm install ${JSON.stringify(tarballPath)} --ignore-scripts --no-audit --no-fund --loglevel=error`, {
      cwd: dir, encoding: "utf8", stdio: "pipe", maxBuffer: 64 * 1024 * 1024,
    });
    const du = execSync("du -sm node_modules", { cwd: dir, encoding: "utf8" });
    const mb = parseInt(du.split("\t")[0], 10);
    const installed = fs.readdirSync(path.join(dir, "node_modules"));
    return { mb, installed };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertBannedInstallNames(installed) {
  const offenders = [];
  for (const name of installed) {
    const top = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name;
    if (BANNED_INSTALL_NAMES.has(name) || (BANNED_INSTALL_NAMES.has(top) && top !== name)) {
      offenders.push(name);
    }
  }
  if (offenders.length > 0) {
    throw new Error(`Banned dependency categories found in the core install closure: ${offenders.join(", ")}`);
  }
}

/**
 * Runs the full verification pipeline. `pkg` = "root" (default) | "core".
 */
export function verifyPack(projectRoot = process.cwd(), opts = {}) {
  const which = opts.core ? "core" : "root";
  const pkgPath = path.join(projectRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  // 1. Static assertion on publish-time hooks (root only — core is script-free)
  assertNoCleanInPublishHooks(pkg);

  if (which === "root") {
    // 2. Stage placeholders if missing
    stagePlaceholderHelpers(projectRoot);

    // 3. Dry-run pack (contents only — the real tarball check is pack+inspect below)
    const stdout = execSync("pnpm pack --dry-run --json", {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    const files = Array.isArray(parsed) ? parsed[0]?.files : parsed?.files;
    if (!Array.isArray(files)) throw new Error(`Unexpected pack json structure: missing files array`);
    const filePaths = files.map((f) => (typeof f === "string" ? f : f.path));
    assertPackFiles(filePaths);

    // 4. Assert not placeholder (FR-039)
    if (!opts.allowPlaceholder) {
      const manifestPath = path.join(projectRoot, "dist/native-fs-commit/manifest.json");
      let manifest = null;
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        } catch {
          manifest = null;
        }
      }
      assertNotPlaceholder(manifest);
    }

    // 5. B-3 no-duplicated-engine (root dist vs core emit, shims whitelisted)
    assertNoDuplicatedEngine(path.join(projectRoot, "dist"), path.join(projectRoot, "packages/core/dist"));

    // 6. release.yml invariants
    assertReleaseWorkflowInvariants(projectRoot);

    // 7. Packed manifest carries no workspace: specifiers
    const tarball = packTarball(projectRoot);
    const manifestJson = readTarballManifest(tarball);
    assertNoWorkspaceSpecifiers(manifestJson, "root tarball");
    fs.rmSync(tarball, { force: true });

    return { success: true, files: filePaths.length };
  }

  // ── core package ──
  // Manifest sanity: script-free, dist-only files, public access.
  if (Object.keys(pkg.scripts ?? {}).length > 0) {
    throw new Error("seepient-core manifest must be script-free (pnpm publish --dry-run would run prepublishOnly — E12)");
  }
  if (JSON.stringify(pkg.files) !== JSON.stringify(["dist"])) {
    throw new Error("seepient-core files must be exactly [\"dist\"]");
  }
  if (pkg.publishConfig?.access !== "public") {
    throw new Error("seepient-core publishConfig.access must be public");
  }

  const tarball = packTarball(projectRoot);
  try {
    const manifestJson = readTarballManifest(tarball);
    assertNoWorkspaceSpecifiers(manifestJson, "core tarball");

    // Weight budget: clean install of the packed tarball ≤ 150 MB unpacked.
    const { mb, installed } = measureCoreInstallWeight(tarball);
    console.log(`[pack-verify] seepient-core clean-install closure: ${mb} MB (budget ${CORE_WEIGHT_BUDGET_MB} MB)`);
    if (mb > CORE_WEIGHT_BUDGET_MB) {
      throw new Error(`Weight budget exceeded: ${mb} MB > ${CORE_WEIGHT_BUDGET_MB} MB`);
    }
    assertBannedInstallNames(installed.filter((n) => n !== ".bin" && n !== ".package-lock.json"));
    return { success: true, weightMb: mb, installedCount: installed.length };
  } finally {
    fs.rmSync(tarball, { force: true });
  }
}

/** Extract package.json from a packed tarball (npm pack-compatible tgz). */
export function readTarballManifest(tarballPath) {
  const out = execSync(`tar -xzf ${JSON.stringify(tarballPath)} -O package/package.json`, { encoding: "utf8" });
  return JSON.parse(out);
}

// Execute when invoked directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const core = process.argv.includes("--core");
  const root = process.cwd();
  const projectRoot = core ? path.join(root, "packages/core") : root;
  try {
    const result = verifyPack(projectRoot, { core });
    if (core) {
      console.log(`✓ Core pack verification passed: ${result.installedCount} packages installed, ${result.weightMb} MB (≤ ${CORE_WEIGHT_BUDGET_MB} MB).`);
    } else {
      console.log(`✓ Pack verification passed: all native helpers and manifest present (${result.files} files); B-3 + workflow invariants green.`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
