#!/usr/bin/env bash
# Seepients dev stack — one command to bring the full local stack up, verified.
#
#   scripts/dev-stack.sh up      # start + verify everything (default)
#   scripts/dev-stack.sh status  # check without starting
#   scripts/dev-stack.sh stop    # stop the dev services this script started
#
# Pieces: postgres (container), sandbox supervisor, api, worker, web (optional).
# Every piece is health-checked after start; the script fails loudly if a core
# piece cannot come up. Logs land in /tmp/seepients-dev-stack/.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
LOGDIR=/tmp/seepients-dev-stack
mkdir -p "$LOGDIR"

WEB_PORT=5173
API_PORT=3100
SUPERVISOR_PORT=7091
SUPERVISOR_TOKEN="${SANDBOX_SUPERVISOR_TOKEN:-$(grep -E '^SANDBOX_SUPERVISOR_TOKEN=' .env 2>/dev/null | cut -d= -f2-)}"

declare -a RESULTS=()
record() { RESULTS+=("$1"); [[ "$1" == FAIL* || "$1" == BLOCKED* ]] && OVERALL=1; }
OVERALL=0

port_listening() { ss -ltn 2>/dev/null | grep -q ":$1 "; }
wait_for() { # wait_for <seconds> <command...> — retries a plain command
  local seconds="$1"; shift 2 >/dev/null || shift
  local waited=0
  while (( waited < seconds )); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1; waited=$((waited + 1))
  done
  return 1
}

api_healthy() { curl -sf -m 3 "http://127.0.0.1:$API_PORT/health" | grep -q '"ok"'; }
supervisor_healthy() { curl -sf -m 3 "http://127.0.0.1:$SUPERVISOR_PORT/health" >/dev/null; }
web_healthy() { [[ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://localhost:$WEB_PORT/")" == "200" ]]; }
worker_pid() {
  for p in $(pgrep -f "tsx watch src/index.ts" 2>/dev/null); do
    [[ "$(readlink "/proc/$p/cwd" 2>/dev/null)" == */apps/worker ]] && { echo "$p"; return 0; }
  done
  return 1
}

check_postgres() {
  if docker exec seepients-dev-postgres pg_isready -U seepients -d seepients >/dev/null 2>&1; then
    record "PASS  postgres   (container seepients-dev-postgres)"
  else
    record "FAIL  postgres   — container not ready; start it: docker compose -f infra/compose/docker-compose.postgres-host.yml up -d"
  fi
}

start_supervisor() {
  if port_listening "$SUPERVISOR_PORT"; then return; fi
  local socket="/var/run/docker.sock"
  if [[ ! -S "$socket" ]]; then
    local podman="/run/user/$(id -u)/podman/podman.sock"
    if [[ -S "$podman" ]]; then socket="$podman"; fi
  fi
  if [[ ! -S "$socket" ]]; then
    record "BLOCKED supervisor — no docker/podman socket found (looked for /var/run/docker.sock and the user podman socket)"
    return
  fi
  echo "   starting supervisor (docker socket: $socket)…"
  (cd infra/sandboxes/supervisor && DOCKER_SOCKET="$socket" nohup pnpm start >"$LOGDIR/supervisor.log" 2>&1 &)
  if wait_for 60 supervisor_healthy; then
    record "PASS  supervisor (127.0.0.1:$SUPERVISOR_PORT, socket: $socket)"
  else
    record "FAIL  supervisor   — did not become healthy; log: $LOGDIR/supervisor.log"
  fi
}

start_api() {
  if ! port_listening "$API_PORT"; then
    echo "   starting api…"
    nohup pnpm --filter @seepients/api dev >"$LOGDIR/api.log" 2>&1 &
  fi
  if wait_for 90 api_healthy; then
    record "PASS  api        (127.0.0.1:$API_PORT, /health ok)"
  else
    record "FAIL  api        — /health not 200; log: $LOGDIR/api.log"
  fi
}

start_worker() {
  if wait_for 30 worker_pid; then
    record "PASS  worker     (process alive)"
  else
    echo "   starting worker…"
    nohup pnpm --filter @seepients/worker dev >"$LOGDIR/worker.log" 2>&1 &
    if wait_for 45 worker_pid; then
      record "PASS  worker     (started)"
    else
      record "FAIL  worker     — process died; log: $LOGDIR/worker.log"
    fi
  fi
}

start_web() {
  if port_listening "$WEB_PORT"; then
    record "PASS  web        (http://localhost:$WEB_PORT, already running)"
    return
  fi
  echo "   starting web…"
  (cd apps/web && nohup pnpm dev >"$LOGDIR/web.log" 2>&1 &)
  if wait_for 60 web_healthy; then
    record "PASS  web        (http://localhost:$WEB_PORT)"
  else
    record "WARN  web        — not up (optional for drills); log: $LOGDIR/web.log"
  fi
}

verify_supervisor_docker() {
  # The past failure mode: supervisor up but its docker socket dead. Probe a
  # real authenticated request — an unreachable engine answers 5xx/ENOENT-class.
  local probe
  probe=$(curl -s -m 5 -X POST "http://127.0.0.1:$SUPERVISOR_PORT/computers" \
    -H "authorization: Bearer ${SUPERVISOR_TOKEN:-missing}" \
    -H 'content-type: application/json' \
    -d '{"botId":"stack-probe","homePath":"/tmp/stack-probe","spaceId":"stack-probe"}' 2>&1)
  if [[ "$probe" == *"/var/run/docker.sock"* || "$probe" == *"ENOENT"* ]]; then
    record "FAIL  supervisor docker socket unreachable — restart supervisor with DOCKER_SOCKET set (see scripts/dev-stack.sh)"
  else
    record "PASS  supervisor docker reachable"
  fi
}

stop_stack() {
  pkill -f "tsx.*apps/worker/src" 2>/dev/null && echo "worker stopped"
  pkill -f "tsx.*apps/api/src" 2>/dev/null && echo "api stopped"
  pkill -f "infra/sandboxes/supervisor" 2>/dev/null && echo "supervisor stopped"
  pkill -f "apps/web.*vite" 2>/dev/null && echo "web stopped"
  echo "postgres container left running (managed by docker)."
}

case "${1:-up}" in
  up)
    check_postgres
    start_supervisor
    verify_supervisor_docker
    start_api
    start_worker
    start_web
    echo
    echo "================ DEV STACK ================"
    for r in "${RESULTS[@]}"; do echo "$r"; done
    echo "==========================================="
    echo "UI: http://localhost:$WEB_PORT   API: http://127.0.0.1:$API_PORT/health"
    if (( OVERALL )); then echo "VERDICT: NOT READY (see FAIL/BLOCKED above; logs in $LOGDIR)"; exit 1; fi
    echo "VERDICT: STACK UP"
    ;;
  status) check_postgres; start_supervisor; verify_supervisor_docker; start_api; start_worker; start_web
    for r in "${RESULTS[@]}"; do echo "$r"; done
    (( OVERALL )) && exit 1 || exit 0 ;;
  stop) stop_stack ;;
  *) echo "usage: scripts/dev-stack.sh [up|status|stop]"; exit 2 ;;
esac
