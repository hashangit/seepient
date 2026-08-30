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
- [ ] **`README.md`**: Update feature highlights, version references, and command examples as needed.
- [ ] **`ARCHITECTURE.md` & Source Layout Sync**:
  - Update `ARCHITECTURE.md` in repository root and `Architecture/ARCHITECTURE.md` in the Obsidian vault.
  - Keep the **Source Layout** directory tree, layer descriptions, and **Key Files** table in sync with any refactoring, newly created directories, or removed files.
- [ ] **`AGENTS.md` & Obsidian Vault Specs**:
  - Update Key Files table and layer guidelines in `AGENTS.md`.
  - Mark completed specs as `SHIPPED` in `AGENTS.md` and in the corresponding Obsidian vault `spec.md`.
  - Ensure `manual-validation-results.md` and any decision notes are recorded in `~/Documents/Obsidian/Seepient/Implementation-Specs/NNN-.../`.
  - Update the vault directory tree index in `AGENTS.md` and vault `README.md`.

---

## 🔀 Phase 3: Pull Request & Automated Ito Code Review

Before merging into `main`, run automated code review via **Ito** and deliberate on all findings:

- [ ] **Open Pull Request**:
  - Commit all release prep changes to your feature/release branch and push to origin:
    ```bash
    git add package.json CHANGELOG.md RELEASE_NOTES-vX.Y.Z.md README.md AGENTS.md src/
    git commit -m "chore(release): bump version to vX.Y.Z and add release notes"
    git push -u origin <release-branch>
    ```
  - Open a PR targeting `main`:
    ```bash
    gh pr create --title "Release vX.Y.Z" --body "Release vX.Y.Z preparation and quality gates."
    ```
- [ ] **Ito Code Review Run**:
  - Wait for the connected **Ito** code review integration to finish reviewing the PR diff and submit its findings.
- [ ] **Deliberate & Validate Findings**:
  - Inspect all comments, flags, and suggested fixes from Ito.
  - Deliberate and validate each point: confirm whether the feedback identifies actual bugs, edge cases, type issues, or architectural drift.
  - Discard/clarify false positives with reasoned deliberation; never blindly apply unverified bot suggestions.
- [ ] **Apply Fixes & Re-test**:
  - Apply validated fixes directly to the branch.
  - Re-run local verification to ensure zero regressions:
    ```bash
    pnpm exec tsc --noEmit && pnpm test && pnpm run build
    ```
  - Push the updates and ensure all Ito review discussions are resolved cleanly.
- [ ] **Merge Gate Clearance**:
  - **Only proceed to merge once Ito code review is complete, all valid issues are addressed, and all PR checks are green.**

---

## 🔀 Phase 4: Merging & Tagging

- [ ] **Merge Pull Request to `main`**:
  ```bash
  gh pr merge --merge --delete-branch
  ```
  *(Or fast-forward / merge locally if required)*:
  ```bash
  git checkout main
  git pull origin main
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

## 🚀 Phase 5: Publishing & CI/CD Verification

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

## ✅ Phase 6: Post-Release Verification

- [ ] **npm Registry**:
  ```bash
  npm view seepient@X.Y.Z version
  ```
- [ ] **Homebrew Tap**:
  - Verify formula updated in `https://github.com/hashangit/homebrew-seepient/blob/main/Formula/seepient.rb`.
- [ ] **GitHub Releases**:
  - Verify release tag and notes on `https://github.com/hashangit/seepient/releases/tag/vX.Y.Z`.
- [ ] **CLI Verification (Homebrew)**:
  ```bash
  brew update
  brew upgrade seepient
  seepient --version
  ```
  *(Note: For systems managing Seepient via Homebrew, do not install via `npm -g` to avoid binary collision.)*
