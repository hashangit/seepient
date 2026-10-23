#!/usr/bin/env bash
# Local browser-journey pipeline — the replacement for the retired
# publish-playwright-report.yml workflow (round 5: local-first CI).
#
#   pnpm e2e:local                    # full journey suite
#   pnpm e2e:local -- --grep onboarding
#   pnpm e2e:local -- --skip-upload
#
# What it does, in order:
#   1. Preflight: refuses to run if dev-stack ports are busy; checks for gws
#      (Google Workspace CLI) unless uploading is skipped.
#   2. Boots a THROWAWAY stack: ephemeral postgres container, api, and worker.
#      Journeys run against SANDBOX_PROVIDER=fake, which needs no supervisor.
#      Nothing here touches your dev stack or its data.
#   3. Runs the Playwright journey suite (apps/web/e2e) with
#      SANDBOX_PROVIDER=fake; Playwright itself starts the web dev server.
#   4. Bundles the HTML report, failure artifacts, service logs, and run
#      metadata into one tarball under .tmp/e2e-evidence/.
#   5. Uploads the bundle to the seepient-e2e-evidence folder on your Google
#      Drive (folder id overridable via E2E_DRIVE_FOLDER) and prints the link.
#   6. Tears down everything it started, leaves the HTML report in place.
#
# Exit code is Playwright's exit code; upload failure is reported but does not
# flip the test verdict.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

SKIP_UPLOAD=0
PLAYWRIGHT_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-upload) SKIP_UPLOAD=1; shift ;;
    --help|-h)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --) shift; PLAYWRIGHT_ARGS+=("$@"); break ;;
    *) PLAYWRIGHT_ARGS+=("$1"); shift ;;
  esac
done

STAMP="$(date -u +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
EVIDENCE_ROOT=".tmp/e2e-evidence"
E2E_DRIVE_FOLDER="${E2E_DRIVE_FOLDER:-1UXL_CR4oC8nRjFAq1E2w1Hx6s8n7_DSG}"

die() { echo "e2e-local: $*" >&2; exit 2; }
port_listening() { ss -ltn 2>/dev/null | grep -q ":$1 "; }
wait_for() { local seconds="$1"; shift; local waited=0; while (( waited < seconds )); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 1; waited=$((waited + 1)); done; return 1; }

declare -a CLEANUP_PIDS=()
cleanup() {
  echo "   tearing down…"
  local pid
  for pid in "${CLEANUP_PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill -- -"$pid" 2>/dev/null
  done
  [[ -n "${PG_CONTAINER:-}" ]] && docker rm -f "$PG_CONTAINER" >/dev/null 2>&1
  [[ -n "${PG_CONTAINER:-}" ]] && podman rm -f "$PG_CONTAINER" >/dev/null 2>&1
  return 0
}
trap cleanup EXIT

# --- 1. preflight -----------------------------------------------------------
for port in 3100 5173 7091; do
  if port_listening "$port"; then
    die "port $port is busy — your dev stack is probably up. Run 'pnpm stack:stop' first (this script refuses to share ports with it)."
  fi
done
if (( ! SKIP_UPLOAD )) && ! command -v gws >/dev/null 2>&1; then
  die "gws (Google Workspace CLI) not found — install/authenticate it, or pass --skip-upload."
fi
CONTAINER_CLI=""
if command -v podman >/dev/null 2>&1; then CONTAINER_CLI="podman"; fi
if command -v docker >/dev/null 2>&1; then CONTAINER_CLI="docker"; fi
[[ -n "$CONTAINER_CLI" ]] || die "no podman/docker found — postgres is required."

# Same environment the systemd units inject (EnvironmentFile=.env). Sourced
# BEFORE the ephemeral DATABASE_URL below so the throwaway db always wins.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

STAGING="$EVIDENCE_ROOT/$STAMP"
LOGDIR="$STAGING/logs"
PG_CONTAINER="seepients-e2e-pg-$$"
mkdir -p "$LOGDIR"

# --- 2. throwaway stack -----------------------------------------------------
echo "[1/4] postgres (ephemeral container $PG_CONTAINER)…"
# Fully-qualified reference: podman refuses short names without a TTY.
PG_IMAGE="${E2E_PG_IMAGE:-docker.io/library/postgres:17-alpine}"
"$CONTAINER_CLI" run -d --rm --name "$PG_CONTAINER" \
  -e POSTGRES_USER=seepients -e POSTGRES_PASSWORD=e2e-local -e POSTGRES_DB=seepients \
  --tmpfs /var/lib/postgresql/data \
  -p "127.0.0.1::5432" "$PG_IMAGE" >/dev/null 2>&1 \
  || die "could not start the postgres container ($PG_IMAGE)"
PG_PORT=$("$CONTAINER_CLI" port "$PG_CONTAINER" 5432 | head -n1 | sed -E 's/.*127\.0\.0\.1:([0-9]+).*/\1/')
export DATABASE_URL="postgresql://seepients:e2e-local@127.0.0.1:$PG_PORT/seepients"
wait_for 30 "$CONTAINER_CLI" exec "$PG_CONTAINER" pg_isready -U seepients -d seepients \
  || die "postgres did not become ready"
pnpm --filter @seepients/db generate >/dev/null 2>&1 || die "prisma generate failed"
pnpm --filter @seepients/db migrate >/dev/null 2>&1 || die "prisma migrate deploy failed"

echo "[2/4] api + worker (SANDBOX_PROVIDER=${E2E_SANDBOX_PROVIDER:-fake})…"
export SANDBOX_PROVIDER="${E2E_SANDBOX_PROVIDER:-fake}"
api_healthy() { curl -sf -m 3 "http://127.0.0.1:3100/health" | grep -q '"ok"'; }
setsid nohup pnpm --filter @seepients/api dev >"$LOGDIR/api.log" 2>&1 &
CLEANUP_PIDS+=("$!")
wait_for 90 api_healthy || { tail -20 "$LOGDIR/api.log" >&2; die "api did not become healthy"; }
setsid nohup pnpm --filter @seepients/worker dev >"$LOGDIR/worker.log" 2>&1 &
CLEANUP_PIDS+=("$!")
wait_for 20 pgrep -f "@seepients/worker dev" || echo "   WARNING: worker process not detected; journeys needing background work will fail"

# --- 3. journeys ------------------------------------------------------------
echo "[3/4] browser journeys (Playwright)…"
pnpm --filter web exec playwright install chromium >/dev/null 2>&1 \
  || echo "   WARNING: browser install failed. If cdn.playwright.dev times out (30s downloader cap on slow routes): download builds/cft/<ver>/linux64/{chrome-linux64,chrome-headless-shell-linux64}.zip with curl, serve the parent dir with 'python3 -m http.server', then run with PLAYWRIGHT_DOWNLOAD_HOST=http://127.0.0.1:<port>" >&2
JOURNEY_START=$(date +%s)
# Deliberately NO set -e from here: the tar and the Drive upload below are the
# least reliable steps, and the header promises they never flip Playwright's
# exit code.
pnpm --filter web exec playwright test "${PLAYWRIGHT_ARGS[@]:-}" 2>&1 | tee "$LOGDIR/playwright.log"
PLAYWRIGHT_RC=${PIPESTATUS[0]}
JOURNEY_SECONDS=$(( $(date +%s) - JOURNEY_START ))

# --- 4. evidence bundle + Drive upload --------------------------------------
echo "[4/4] evidence bundle…"
mkdir -p "$STAGING"
cp -r apps/web/playwright-report "$STAGING/playwright-report" 2>/dev/null || true
cp -r apps/web/test-results "$STAGING/test-results" 2>/dev/null || true
{
  echo "run:        $STAMP"
  echo "date:       $(date -u +%FT%TZ)"
  echo "exit_code:  $PLAYWRIGHT_RC"
  echo "duration_s: $JOURNEY_SECONDS"
  echo "grep:       ${PLAYWRIGHT_ARGS[*]:-(full suite)}"
  echo "summary:    $(grep -E '[0-9]+ (passed|failed)' "$LOGDIR/playwright.log" | tail -n1)"
} > "$STAGING/run-metadata.txt"

DRIVE_LINK=""
if (( ! SKIP_UPLOAD )); then
  TARBALL_NAME="seepient-e2e-$STAMP.tar.gz"
  (cd "$EVIDENCE_ROOT" && tar czf "$TARBALL_NAME" "$STAMP")
  echo "   uploading $TARBALL_NAME to Google Drive…"
  DRIVE_LINK=$( (cd "$EVIDENCE_ROOT" && gws drive files create \
    --upload "$TARBALL_NAME" --upload-content-type application/gzip \
    --json "{\"name\": \"$TARBALL_NAME\", \"parents\": [\"$E2E_DRIVE_FOLDER\"]}" \
    --params '{"fields": "id,webViewLink"}' --format json 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('webViewLink') or ('https://drive.google.com/file/d/' + d['id'] + '/view'))" 2>/dev/null) )
  if [[ -n "$DRIVE_LINK" ]]; then
    echo "   evidence: $DRIVE_LINK"
  else
    echo "   WARNING: Drive upload failed — the tarball is at $EVIDENCE_ROOT/$TARBALL_NAME" >&2
  fi
fi

echo
echo "HTML report: apps/web/playwright-report/index.html (open: pnpm --filter web exec playwright show-report)"
exit "$PLAYWRIGHT_RC"
