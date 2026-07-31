#!/usr/bin/env bash
# Publish seepient: bump version, tag, and push to trigger the release workflow.
#
# The release workflow (.github/workflows/release.yml) then publishes to:
#   1. npm (seepient)
#   2. the hashangit/homebrew-seepient tap (formula auto-bumped)
#   3. a GitHub Release
#
# Usage:
#   ./scripts/publish.sh                  # interactive: pick patch/minor/major
#   ./scripts/publish.sh patch            # 0.3.0 -> 0.3.1
#   ./scripts/publish.sh minor            # 0.3.0 -> 0.4.0
#   ./scripts/publish.sh major            # 0.3.0 -> 1.0.0
#   ./scripts/publish.sh 1.2.3            # explicit version
#   ./scripts/publish.sh patch --dry-run  # show what would happen, change nothing
#
# Requires: git, gh (authenticated), npm (for registry checks), jq
set -euo pipefail

# --- path setup -----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# --- color helpers --------------------------------------------------------
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  CYAN=$'\033[36m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; DIM=""; RESET=""
fi

info()  { printf "${CYAN}ℹ${RESET}  %s\n" "$*"; }
ok()    { printf "${GREEN}✓${RESET}  %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${RESET}  %s\n" "$*"; }
err()   { printf "${RED}✗${RESET}  %s\n" "$*" >&2; }
die()   { err "$*"; exit 1; }

# --- arg parsing ----------------------------------------------------------
BUMP="${1:-}"
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=true ;;
  esac
done

# --- preflight checks -----------------------------------------------------
[[ -f package.json ]] || die "Not in seepient repo: no package.json at $REPO_ROOT"

command -v git >/dev/null || die "git is required"
command -v gh  >/dev/null || die "gh CLI is required (https://cli.github.com)"
command -v jq  >/dev/null || die "jq is required"
gh auth status >/dev/null 2>&1 || die "gh CLI is not authenticated. Run: gh auth login"

PKG_NAME=$(jq -r .name package.json)
[[ "$PKG_NAME" == "seepient" ]] || die "Unexpected package name: $PKG_NAME"

CURRENT_VERSION=$(jq -r .version package.json)
DEFAULT_BRANCH="main"

info "Repo:        $(git remote get-url origin)"
info "Package:     $PKG_NAME"
info "On branch:   $(git rev-parse --abbrev-ref HEAD)"
info "Local ver:   $CURRENT_VERSION"
echo

# --- guard 1: must be on the default branch -------------------------------
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "$DEFAULT_BRANCH" ]]; then
  die "Must be on '$DEFAULT_BRANCH' (currently on '$CURRENT_BRANCH').
       Merge your feature branch first: git checkout main && git merge $CURRENT_BRANCH"
fi

# --- guard 2: working tree must be clean ----------------------------------
if [[ -n "$(git status --porcelain)" ]]; then
  die "Working tree is dirty. Commit or stash changes first:
       git status
       git stash   # or git commit -am '...'"
fi

# --- guard 3: local main must match origin --------------------------------
git fetch origin "$DEFAULT_BRANCH" --quiet
LOCAL_MAIN=$(git rev-parse "$DEFAULT_BRANCH")
REMOTE_MAIN=$(git rev-parse "origin/$DEFAULT_BRANCH")
if [[ "$LOCAL_MAIN" != "$REMOTE_MAIN" ]]; then
  die "Local '$DEFAULT_BRANCH' ($LOCAL_MAIN) is out of sync with origin ($REMOTE_MAIN).
       Run: git pull --ff-only   (or git push if local is ahead)"
fi

# --- guard 4: current version must already be published to npm ------------
# This proves the PREVIOUS release completed. If the local version isn't on npm,
# a prior release silently failed and we should not pile a new one on top.
NPM_LATEST=$(npm view "$PKG_NAME" version 2>/dev/null || echo "")
if [[ -z "$NPM_LATEST" ]]; then
  die "Could not reach npm registry for $PKG_NAME. Check network/VPN."
fi
if [[ "$CURRENT_VERSION" != "$NPM_LATEST" ]]; then
  die "Version mismatch: package.json=$CURRENT_VERSION but npm latest=$NPM_LATEST.
       The previous release did not complete. Either:
         - publish $CURRENT_VERSION to npm manually, OR
         - the npm publish step in the last release workflow failed (check it)."
fi
ok "Local $CURRENT_VERSION matches npm latest ($NPM_LATEST) — previous release OK"

# --- resolve target version ------------------------------------------------
# Strip the --dry-run flag from BUMP if it was passed as the first positional
BUMP="${1:-}"
[[ "$BUMP" == "--dry-run" || "$BUMP" == "-n" ]] && BUMP=""

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  TARGET_VERSION="$BUMP"
elif [[ "$BUMP" == "patch" || "$BUMP" == "minor" || "$BUMP" == "major" ]]; then
  TARGET_VERSION=$(npm version "$BUMP" --no-git-tag-version --silent | tr -d 'v')
elif [[ -z "$BUMP" ]]; then
  # no argument -> interactive prompt
  MAJ=$(echo "$CURRENT_VERSION" | cut -d. -f1)
  MIN=$(echo "$CURRENT_VERSION" | cut -d. -f2)
  PAT=$(echo "$CURRENT_VERSION" | cut -d. -f3)
  PATCH_NEXT="$MAJ.$MIN.$((PAT+1))"
  MINOR_NEXT="$MAJ.$((MIN+1)).0"
  MAJOR_NEXT="$((MAJ+1)).0.0"
  echo "${BOLD}Current version:${RESET} $CURRENT_VERSION"
  echo "Pick a bump:"
  echo "  ${CYAN}1${RESET}) patch  -> $PATCH_NEXT"
  echo "  ${CYAN}2${RESET}) minor  -> $MINOR_NEXT"
  echo "  ${CYAN}3${RESET}) major  -> $MAJOR_NEXT"
  echo "  ${CYAN}q${RESET}) quit"
  read -r -p "Choice [1-3]: " choice </dev/tty
  case "$choice" in
    1) BUMP="patch" ;;
    2) BUMP="minor" ;;
    3) BUMP="major" ;;
    *) die "Aborted." ;;
  esac
  TARGET_VERSION=$(npm version "$BUMP" --no-git-tag-version --silent | tr -d 'v')
else
  die "Invalid version argument: '$BUMP'
       Expected: patch | minor | major | <semver> | (nothing for interactive)"
fi

# --- guard 5: target version must not already exist as a git tag ----------
if git rev-parse -q --verify "refs/tags/v$TARGET_VERSION" >/dev/null; then
  die "Tag v$TARGET_VERSION already exists. Pick a higher version."
fi
# also check npm, in case it was published from a different machine
if npm view "$PKG_NAME@$TARGET_VERSION" version >/dev/null 2>&1; then
  die "$TARGET_VERSION already exists on npm. Pick a higher version."
fi

echo
echo "${BOLD}${CYAN}Release summary${RESET}"
echo "  ${DIM}from:${RESET} $CURRENT_VERSION"
echo "  ${DIM}to:${RESET}   $TARGET_VERSION"
echo "  ${DIM}bump:${RESET} $BUMP"
echo

if [[ "$DRY_RUN" == true ]]; then
  info "${BOLD}--dry-run${RESET}: no changes made."
  info "Would have: bumped package.json, committed, tagged v$TARGET_VERSION, pushed."
  exit 0
fi

# --- confirm ---------------------------------------------------------------
read -r -p "Publish $TARGET_VERSION? [y/N] " confirm </dev/tty
[[ "$confirm" =~ ^[Yy]$ ]] || die "Aborted."

# --- run tests -------------------------------------------------------------
info "Running tests (pnpm test)..."
if ! pnpm test >/tmp/seepient-publish-test.log 2>&1; then
  err "Tests failed. See /tmp/seepient-publish-test.log"
  tail -20 /tmp/seepient-publish-test.log
  die "Aborting release."
fi
ok "Tests passed"

# --- execute: bump, generate notes, commit, tag, push ---------------------
info "Bumping package.json to $TARGET_VERSION..."
# already bumped if we went through npm version above; if explicit version arg,
# set it now
if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  npm version "$TARGET_VERSION" --no-git-tag-version --silent >/dev/null
fi

# --- generate release notes via seepient SDK (dogfooding) ---------------------
NOTES_FILE="RELEASE_NOTES-v$TARGET_VERSION.md"
info "Generating release notes (seepient SDK, Keep a Changelog format)..."
if pnpm exec tsx scripts/generate-release-notes.ts "$TARGET_VERSION" 2>&1 \
    | sed 's/^/    /'; then
  if [[ -f "$NOTES_FILE" ]]; then
    ok "Generated $NOTES_FILE"
    echo
    echo "${DIM}--- preview ---${RESET}"
    head -20 "$NOTES_FILE" | sed 's/^/  /'
    echo "${DIM}--- end preview ---${RESET}"
    echo
    read -r -p "Edit $NOTES_FILE before publishing? [y/N] " edit_notes </dev/tty
    if [[ "$edit_notes" =~ ^[Yy]$ ]]; then
      ${EDITOR:-vi} "$NOTES_FILE"
    fi
  else
    warn "Notes file not written. GitHub release will use auto-generated notes."
  fi
else
  warn "Release notes generation failed. GitHub release will use auto-generated notes."
fi

info "Committing..."
git add package.json
[[ -f "$NOTES_FILE" ]] && git add "$NOTES_FILE"
git commit -m "chore(release): v$TARGET_VERSION" --quiet

info "Tagging v$TARGET_VERSION..."
git tag "v$TARGET_VERSION"

info "Pushing commit + tag to origin..."
git push origin "$DEFAULT_BRANCH" --quiet
git push origin "v$TARGET_VERSION" --quiet
ok "Pushed. CI will now: publish to npm, bump homebrew tap, create GitHub release."

# --- watch the workflow ----------------------------------------------------
echo
info "Watching release workflow (Ctrl-C to stop watching; the release continues)..."
sleep 3  # let the workflow register
if gh run list --workflow=release.yml --limit=1 --json databaseId,status -q '.[0].databaseId' \
    | xargs -I{} gh run watch {} --exit-status; then
  ok "${BOLD}Release workflow succeeded.${RESET}"
  echo
  echo "  ${DIM}npm:${RESET}      https://www.npmjs.com/package/$PKG_NAME"
  echo "  ${DIM}homebrew:${RESET} https://github.com/hashangit/homebrew-seepient/commit/main"
  echo "  ${DIM}release:${RESET}  https://github.com/hashangit/seepient/releases/tag/v$TARGET_VERSION"
  echo
  echo "  Install via:  ${CYAN}brew install hashangit/seepient/seepient${RESET}"
  echo "                ${CYAN}npm i -g $PKG_NAME@$TARGET_VERSION${RESET}"
  exit 0
else
  err "${BOLD}Release workflow FAILED.${RESET} Investigate:"
  echo "  gh run list --workflow=release.yml --limit=1"
  echo
  echo "  ${DIM}Note:${RESET} if npm publish succeeded but a later step failed, you may"
  echo "  need to manually bump the homebrew tap or delete the npm version."
  exit 1
fi
