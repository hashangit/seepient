/**
 * Generate release notes for a seepient release using seepient itself (dogfooding).
 *
 * Gathers commits + merged PRs since the last tag, feeds them to the SDK's
 * generateText(), and formats output per Keep a Changelog.
 *
 * Usage:
 *   npx tsx scripts/generate-release-notes.ts <version>
 *   npx tsx scripts/generate-release-notes.ts 0.3.1
 *   npx tsx scripts/generate-release-notes.ts 0.3.1 --stdout   # print, don't write
 *
 * Reads provider config from ~/.seepient/setting.json + .seepient/setting.json + env,
 * exactly like the CLI does. Your existing seepient setup just works.
 */
import { generateText } from "../src/adapters/sdk/index.js";
import { configureProviders } from "../src/core/provider-resolver.js";
import { loadMergedConfig, applyEnvOverrides } from "../src/core/config.js";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// --- args -----------------------------------------------------------------
const VERSION = process.argv[2];
const STDOUT_ONLY = process.argv.includes("--stdout");

if (!VERSION || !/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error("Usage: npx tsx scripts/generate-release-notes.ts <version> [--stdout]");
  console.error("  version must be semver, e.g. 0.3.1");
  process.exit(1);
}

// --- gather git data ------------------------------------------------------
function run(cmd: string): string {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

// Find the previous tag (the last release)
let prevTag = "";
try {
  prevTag = run("git describe --tags --abbrev=0 HEAD~1 2>/dev/null || git describe --tags --abbrev=0 2>/dev/null");
} catch {
  // no previous tag — use first commit
  prevTag = run("git rev-list --max-parents=0 HEAD").split("\n")[0];
}

// Commits since last tag (exclude merge commits for cleaner list)
const commitLog = run(
  `git log ${prevTag}..HEAD --no-merges --pretty=format:"- %h %s (%an)"`,
);

// Merged PRs since last tag (if gh is available)
let prList = "";
try {
  prList = run(
    `gh pr list --state merged --limit 50 --json number,title,author,labels ` +
    `--jq '.[] | "- #\\(.number) \\(.title) [by @\\(.author.login)]"'`,
  );
} catch {
  prList = "(gh CLI not available or no PRs found)";
}

const today = new Date().toISOString().slice(0, 10);

// --- the prompt -----------------------------------------------------------
const prompt = `You are generating release notes for version ${VERSION} of seepient, a headless AI agent framework.

Below is the raw data of changes since the previous release (${prevTag}):

## Git Commits (since ${prevTag})
${commitLog || "(none)"}

## Merged Pull Requests
${prList || "(none)"}

## Instructions
Write release notes in **Keep a Changelog** format. Rules:
1. Start with the header: \`## [${VERSION}] - ${today}\`
2. Add a 1-2 sentence summary of the release highlights below the header.
3. Categorize changes under these section headings (omit empty sections):
   - **Added** — new features
   - **Changed** — changes to existing functionality
   - **Deprecated** — soon-to-be removed
   - **Removed** — removed features
   - **Fixed** — bug fixes
   - **Security** — vulnerability fixes
4. Each bullet should be a concise, user-facing description (not a raw commit message).
   - Rewrite "feat(tui): add autocomplete" as "Added autocomplete to the TUI prompt"
   - Rewrite "fix: null deref in agent-loop" as "Fixed a crash in the agent loop when ..."
5. Group related commits into single bullets where it makes sense.
6. Use conventional-commit prefixes to guide categorization (feat→Added, fix→Fixed, refactor→Changed, docs→skip unless user-facing, chore→skip, test→skip).
7. Skip pure refactors, test additions, and chore commits UNLESS they're user-visible.
8. Output ONLY the markdown release notes — no preamble, no explanation, no code fences.`;

// --- call the SDK ---------------------------------------------------------
// generateText() resolves the provider via configureProviders() singleton or env
// vars — it does NOT read opts.config.provider. So we mirror what the CLI does:
// load merged config and register it globally before the call.
const config = applyEnvOverrides(loadMergedConfig());
const providerType = config.provider || "openai";
const providerModel =
  config.models?.[providerType]?.model || config.model || undefined;

if (config.models) {
  configureProviders({ default: providerType, ...config.models } as any);
}

console.error(`Generating release notes for v${VERSION} (since ${prevTag})...`);
console.error(`Provider: ${providerType} | Model: ${providerModel || "default"}`);

let result;
try {
  result = await generateText(prompt, {
    provider: providerType,
    model: providerModel,
    config,
    maxSteps: 3,
  });
} catch (e) {
  console.error("Failed to generate release notes:", e instanceof Error ? e.message : e);
  console.error("\nFalling back to raw commit list.");
  const fallback = `## [${VERSION}] - ${today}\n\n${commitLog || "(no changes)"}\n`;
  if (STDOUT_ONLY) {
    process.stdout.write(fallback);
  } else {
    const outPath = join(REPO_ROOT, `RELEASE_NOTES-v${VERSION}.md`);
    writeFileSync(outPath, fallback);
    console.error(`Wrote ${outPath} (fallback)`);
  }
  process.exit(0);
}

const notes = result.text.trim();

if (!notes) {
  console.error("Warning: empty response from model. Falling back to raw commit list.");
}

const output = notes || `## [${VERSION}] - ${today}\n\n${commitLog || "(no changes)"}\n`;

if (STDOUT_ONLY) {
  process.stdout.write(output + "\n");
} else {
  const outPath = join(REPO_ROOT, `RELEASE_NOTES-v${VERSION}.md`);
  writeFileSync(outPath, output + "\n");
  console.error(`Wrote ${outPath}`);
  console.error(`Tokens: ${result.usage.totalTokens ?? "?"} | Steps: ${result.steps.length}`);
}
