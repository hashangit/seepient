# Seepient Release Checklist 🦞

This document is the standard operational runbook to follow when preparing, verifying, and publishing a new release of **Seepient**.

---

## 📋 Phase 1: Pre-Release Quality & Gate Verification

Before touching version numbers or cutting release commits, ensure the entire repository passes all quality gates:

- [ ] **Clean Working Tree**: Ensure your working tree on your feature branch or `main` is clean.
- [ ] **Typecheck**:
  ```bash
  pnpm exec tsc --noEmit && pnpm exec tsc --noEmit -p tsconfig.test.json
  ```
- [ ] **Full Test Suite**:
  ```bash
  pnpm test
  ```
  *(100% of non-skipped test files must pass with zero failures.)*
- [ ] **Architecture Layer Boundaries**:
  ```bash
  pnpm vitest run src/foundations/contracts/__tests__/architecture-boundaries.test.ts
  ```
- [ ] **Build Output**:
  ```bash
  pnpm run build
  ```
- [ ] **Assert Zero JSX in Headless Outputs (CI requirement)**:
  ```bash
  if grep -rlE "jsx-runtime" \
      dist/ui/cli/index.js \
      dist/ui/repl/repl.js \
      dist/transport/cli/bootstrap.js \
      dist/transport/cli/agent.js \
      dist/transport/http \
      dist/transport/sdk \
      dist/domain 2>/dev/null; then
    echo "ERROR: React/JSX leaked into a headless build output"
    exit 1
  fi
  ```
- [ ] **Manual TUI Smoke (if UI/CLI touched)**:
  - Run `seepient` interactive mode.
  - Verify logo banner displays correct version.
  - Cycle tabs in `/models` dock (`Jobs` → `Providers` → `Now`).
  - Verify `Esc` backs out of overlays cleanly.

---

## 📦 Phase 2: Version Bumping & Documentation Sync

Update all version strings and documentation artifacts in lockstep:

- [ ] **`package.json`**: Bump `"version": "X.Y.Z"`.
- [ ] **`CHANGELOG.md`**:
  - Add new section under `[Unreleased]` formatted as `## [vX.Y.Z] - YYYY-MM-DD`.
  - Document all major changes, new capabilities, fixes, and architectural improvements.
- [ ] **`RELEASE_NOTES-vX.Y.Z.md`**:
  - Create release notes file in repo root (picked up automatically by `.github/workflows/release.yml` for GitHub Releases).
- [ ] **Logo & Version Fallbacks**:
  - `src/ui/tui/components/logo-banner.tsx`: Resolves dynamically from `package.json` with fallback.
  - `src/ui/cli/index.ts`: Verify fallback `version` matches `X.Y.Z`.
- [ ] **`README.md`**: Update feature highlights, version references, and command examples as needed.
- [ ] **`AGENTS.md` & Vault Specs**:
  - Mark completed specs as `SHIPPED` in `AGENTS.md` and in the corresponding Obsidian vault spec files.

---

## 🔀 Phase 3: Committing, Merging & Tagging

- [ ] **Commit Release Prep**:
  ```bash
  git add package.json CHANGELOG.md RELEASE_NOTES-vX.Y.Z.md README.md AGENTS.md src/ui/
  git commit -m "chore(release): bump version to vX.Y.Z and add release notes"
  ```
- [ ] **Merge Feature Branch to `main`** (if releasing from a branch):
  ```bash
  git checkout main
  git merge --no-ff <feature-branch> -m "feat: <feature description> and release vX.Y.Z"
  ```
- [ ] **Create Annotated Tag**:
  ```bash
  git tag -a vX.Y.Z -m "Release vX.Y.Z - <Summary of Release>"
  ```
- [ ] **Verify Tag Locally**:
  ```bash
  git tag -n1 -l "vX.Y.Z"
  ```

---

## 🚀 Phase 4: Publishing & CI/CD Verification

Push the branch and tag to trigger the automated GitHub Actions release workflow:

- [ ] **Push Commits and Tag**:
  ```bash
  git push origin main
  git push origin vX.Y.Z
  ```
- [ ] **Monitor GitHub Actions**:
  ```bash
  gh run list -L 3
  ```
  *(Locate the `Release` workflow for tag `vX.Y.Z`)*
- [ ] **Verify All Release Jobs Complete Green**:
  ```bash
  gh run view <run-id>
  ```
  Ensure all 4 jobs succeed:
  1. `test`: Full test suite on Ubuntu runner.
  2. `publish-npm`: Publishes `seepient@X.Y.Z` to npm registry.
  3. `publish-homebrew`: Updates formula `url` and `sha256` in `hashangit/homebrew-seepient`.
  4. `github-release`: Creates GitHub release with release notes.

---

## ✅ Phase 5: Post-Release Verification

- [ ] **npm Registry**:
  ```bash
  npm view seepient@X.Y.Z version
  ```
- [ ] **Homebrew Tap**:
  - Verify formula updated in `https://github.com/hashangit/homebrew-seepient/blob/main/Formula/seepient.rb`.
- [ ] **GitHub Releases**:
  - Verify release tag and notes on `https://github.com/hashangit/seepient/releases/tag/vX.Y.Z`.
- [ ] **Global CLI Test (Optional)**:
  ```bash
  npm install -g seepient@X.Y.Z
  seepient --version
  ```
