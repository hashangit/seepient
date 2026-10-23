#!/usr/bin/env bash
# Seepients dev stack — bring the local stack up, check it, stop it.
#
#   scripts/dev-stack.sh up      # start + verify everything (default)
#   scripts/dev-stack.sh status  # read-only health report; starts nothing
#   scripts/dev-stack.sh stop    # stop api/worker/supervisor/web
#
# Two backends, chosen automatically:
#   systemd (preferred): if seepients-*.service user units exist and point at
#     this worktree, the stack is driven through `systemctl --user`. The units
#     carry Restart=always, so killing processes directly just makes systemd
#     resurrect them — stop must go through systemctl.
#   direct (fallback): setsid process groups recorded in $LOGDIR/pids, health-
#     checked with real probes, swept by port on stop (tsx watch does not kill
#     its served child, so listeners can outlive every recorded parent).
#
# postgres is a container you manage (compose or a unit) — checked, never
# started or stopped here. Logs land in /tmp/seepients-dev-stack/.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
LOGDIR=/tmp/seepients-dev-stack
PIDFILE="$LOGDIR/pids"
mkdir -p "$LOGDIR"

WEB_PORT=5173
API_PORT=3100
SUPERVISOR_PORT=7091
SUPERVISOR_TOKEN="${SANDBOX_SUPERVISOR_TOKEN:-$(grep -E '^SANDBOX_SUPERVISOR_TOKEN=' .env 2>/dev/null | cut -d= -f2-)}"
SYSTEMD_UNITS=(seepients-postgres seepients-supervisor seepients-api seepients-worker seepients-web)
APP_UNITS=(seepients-supervisor seepients-api seepients-worker seepients-web)

declare -a RESULTS=()
record() { RESULTS+=("$1"); [[ "$1" == FAIL* || "$1" == BLOCKED* ]] && OVERALL=1; }
OVERALL=0

container_cli() {
  if command -v docker >/dev/null 2>&1; then echo docker
  elif command -v podman >/dev/null 2>&1; then echo podman
  else echo ""; fi
}

# --- backend selection -------------------------------------------------------
using_systemd_stack() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user cat seepients-api.service >/dev/null 2>&1 || return 1
  # The units are machine-local; only claim them when they target this tree.
  local root; root=$(pwd)
  systemctl --user cat seepients-api.service 2>/dev/null | grep -qF "$root"
}

# --- shared probes -----------------------------------------------------------
port_listening() { ss -ltn 2>/dev/null | grep -q ":$1 "; }
wait_for() { # wait_for <seconds> <command...> — retries a plain command
  local seconds="$1"; shift
  local waited=0
  while (( waited < seconds )); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1; waited=$((waited + 1))
  done
  return 1
}
port_free() { ! port_listening "$1"; }

api_healthy() { curl -sf -m 3 "http://127.0.0.1:$API_PORT/health" | grep -q '"ok"'; }
supervisor_healthy() { curl -sf -m 3 "http://127.0.0.1:$SUPERVISOR_PORT/health" >/dev/null; }
web_healthy() { [[ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://localhost:$WEB_PORT/")" == "200" ]]; }

check_postgres() {
  local cli; cli=$(container_cli)
  if [[ -z "$cli" ]]; then
    record "BLOCKED postgres — no docker/podman CLI found"
    return
  fi
  local cid
  cid=$("$cli" ps --format '{{.Names}}' 2>/dev/null | grep -i postgres | head -n1)
  if [[ -n "$cid" ]] && "$cli" exec "$cid" pg_isready -U seepients -d seepients >/dev/null 2>&1; then
    record "PASS  postgres   (container $cid)"
  else
    record "FAIL  postgres   — no ready postgres container; start it:"
    record "      docker compose --env-file .env -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.postgres-host.yml up postgres -d"
  fi
}

# --- systemd backend ---------------------------------------------------------
sd_active() { systemctl --user is-active --quiet "$1" 2>/dev/null; }

sd_up() {
  local unit
  check_postgres
  for unit in "${APP_UNITS[@]}"; do
    sd_active "$unit" || systemctl --user start "$unit" 2>/dev/null
  done
  if wait_for 60 supervisor_healthy; then
    record "PASS  supervisor (127.0.0.1:$SUPERVISOR_PORT)"
  else
    record "FAIL  supervisor   — unhealthy; journal: journalctl --user -u seepients-supervisor"
  fi
  if wait_for 90 api_healthy; then
    record "PASS  api        (127.0.0.1:$API_PORT, /health ok)"
  else
    record "FAIL  api        — unhealthy; journal: journalctl --user -u seepients-api"
  fi
  if wait_for 20 sd_active seepients-worker; then
    record "PASS  worker     (unit active)"
  else
    record "FAIL  worker     — unit not active; journal: journalctl --user -u seepients-worker"
  fi
  if wait_for 60 web_healthy; then
    record "PASS  web        (http://localhost:$WEB_PORT)"
  else
    record "WARN  web        — not up (optional); journal: journalctl --user -u seepients-web"
  fi
  verify_supervisor_docker
}

sd_status() {
  local unit state
  check_postgres
  for unit in "${APP_UNITS[@]}"; do
    if sd_active "$unit"; then state="active"; else state="inactive"; fi
    case "$unit" in
      seepients-supervisor) [[ "$state" == active ]] && supervisor_healthy && state="healthy" || [[ "$state" == active ]] && state="unhealthy" ;;
      seepients-api) [[ "$state" == active ]] && api_healthy && state="healthy" || [[ "$state" == active ]] && state="unhealthy" ;;
      seepients-web) [[ "$state" == active ]] && web_healthy && state="healthy" || [[ "$state" == active ]] && state="unhealthy" ;;
    esac
    record "$([[ "$state" == inactive || "$state" == unhealthy ]] && echo FAIL || echo PASS)  ${unit#seepients-} ($state)"
  done
}

sd_stop() {
  local unit
  for unit in seepients-api seepients-worker seepients-supervisor seepients-web; do
    sd_active "$unit" && systemctl --user stop "$unit" 2>/dev/null
  done
  # Units honor an explicit stop, but sweep strays anyway; a stop that lies is
  # what the old version did.
  local port
  for port in "$API_PORT" "$WEB_PORT" "$SUPERVISOR_PORT"; do
    kill_port_listener "$port"
  done
  wait_for 10 port_free "$API_PORT" && wait_for 5 port_free "$WEB_PORT" \
    || echo "WARNING: some ports are still listening after stop"
  echo "postgres left as-is (its unit/container is managed separately)."
}

# --- shared helpers ----------------------------------------------------------
kill_port_listener() {
  local port="$1" pid
  port_listening "$port" || return 0
  for pid in $(ss -ltnp 2>/dev/null | grep ":$port " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
    kill "$pid" 2>/dev/null && echo "  killed leftover listener $pid on :$port"
  done
}

# --- direct backend ----------------------------------------------------------
# Service discovery by process tree. The real command lines are
#   node .../dev-watch.mjs src/index.ts              (the dev-watch PARENT)
#   node .../tsx/dist/cli.mjs watch src/index.ts     (its child)
# with cwd disambiguating the service. Kill order matters: the dev-watch
# parent first (it forwards TERM to its child and exits), then any orphaned
# child — killing only the child makes dev-watch treat it as a crash and
# respawn the service seconds later.
watch_parent_pids() {
  local p
  for p in $(pgrep -f "scripts/dev-watch\.mjs" 2>/dev/null); do
    [[ "$(readlink "/proc/$p/cwd" 2>/dev/null)" == *"$1" ]] && echo "$p"
  done
}
pids_for_cwd() {
  local p
  for p in $(pgrep -f "tsx.*cli\.mjs watch src/index\.ts" 2>/dev/null); do
    [[ "$(readlink "/proc/$p/cwd" 2>/dev/null)" == *"$1" ]] && echo "$p"
  done
}
worker_service_pids() { watch_parent_pids "/apps/worker"; pids_for_cwd "/apps/worker"; }
api_service_pids() { watch_parent_pids "/apps/api"; pids_for_cwd "/apps/api"; }
supervisor_service_pids() { watch_parent_pids "/infra/sandboxes/supervisor"; pids_for_cwd "/infra/sandboxes/supervisor"; }
web_pids() {
  local p
  for p in $(pgrep -f "vite" 2>/dev/null); do
    [[ "$(readlink "/proc/$p/cwd" 2>/dev/null)" == */apps/web ]] && echo "$p"
  done
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
  (cd infra/sandboxes/supervisor && DOCKER_SOCKET="$socket" setsid nohup pnpm start >"$LOGDIR/supervisor.log" 2>&1 & echo $! >"$PIDFILE.supervisor")
  if wait_for 60 supervisor_healthy; then
    mv "$PIDFILE.supervisor" "$PIDFILE.supervisor.live" 2>/dev/null
    record "PASS  supervisor (127.0.0.1:$SUPERVISOR_PORT, socket: $socket)"
  else
    rm -f "$PIDFILE.supervisor"
    record "FAIL  supervisor   — did not become healthy; log: $LOGDIR/supervisor.log"
  fi
}

start_api() {
  if port_listening "$API_PORT"; then return; fi
  echo "   starting api…"
  setsid nohup pnpm --filter @seepients/api dev >"$LOGDIR/api.log" 2>&1 & echo $! >"$PIDFILE.api"
  if wait_for 90 api_healthy; then
    record "PASS  api        (127.0.0.1:$API_PORT, /health ok)"
  else
    record "FAIL  api        — /health not 200; log: $LOGDIR/api.log"
  fi
}

start_worker() {
  if [[ -n "$(worker_service_pids)" ]]; then
    record "PASS  worker     (already running)"
    return
  fi
  echo "   starting worker…"
  setsid nohup pnpm --filter @seepients/worker dev >"$LOGDIR/worker.log" 2>&1 & echo $! >"$PIDFILE.worker"
  if wait_for 30 worker_service_pids; then
    record "PASS  worker     (started)"
  else
    record "FAIL  worker     — process died; log: $LOGDIR/worker.log"
  fi
}

start_web() {
  if port_listening "$WEB_PORT"; then
    record "PASS  web        (http://localhost:$WEB_PORT, already running)"
    return
  fi
  echo "   starting web…"
  (cd apps/web && setsid nohup pnpm dev >"$LOGDIR/web.log" 2>&1 & echo $! >"$PIDFILE.web")
  if wait_for 60 web_healthy; then
    record "PASS  web        (http://localhost:$WEB_PORT)"
  else
    record "WARN  web        — not up (optional for drills); log: $LOGDIR/web.log"
  fi
}

verify_supervisor_docker() {
  # The past failure mode: supervisor up but its docker socket dead. Probe a
  # real authenticated request and judge by HTTP status, not by error text —
  # an unreachable engine must FAIL, not pass.
  local code
  code=$(curl -s -m 5 -o "$LOGDIR/docker-probe.json" -w '%{http_code}' -X POST "http://127.0.0.1:$SUPERVISOR_PORT/computers" \
    -H "authorization: Bearer ${SUPERVISOR_TOKEN:-missing}" \
    -H 'content-type: application/json' \
    -d '{"botId":"stack-probe","homePath":"/tmp/stack-probe","spaceId":"stack-probe"}' 2>/dev/null) || code="000"
  if [[ "$code" =~ ^2 ]]; then
    record "PASS  supervisor docker reachable"
  else
    record "FAIL  supervisor docker unreachable — HTTP $code; restart supervisor with DOCKER_SOCKET set (excerpt: $(head -c 120 "$LOGDIR/docker-probe.json" 2>/dev/null))"
  fi
}

kill_service() { # kill_service <name> <pidfile> <pids...>
  local name="$1" pidfile="$2"; shift 2
  local pids=("$@") killed=0 pid
  if [[ -f "$pidfile" ]]; then
    pid=$(cat "$pidfile" 2>/dev/null)
    if [[ -n "$pid" ]] && kill -0 -- "-$pid" 2>/dev/null; then
      kill -- -"$pid" 2>/dev/null && killed=1
    fi
    rm -f "$pidfile"
  fi
  for pid in ${pids[@]:-}; do
    kill "$pid" 2>/dev/null && killed=1
  done
  if (( killed )); then echo "$name stopped"; else echo "$name was not running"; fi
}

direct_stop() {
  kill_service "worker" "$PIDFILE.worker" "$(worker_service_pids)"
  kill_service "api" "$PIDFILE.api" "$(api_service_pids)"
  kill_service "supervisor" "$PIDFILE.supervisor.live" "$(supervisor_service_pids)"
  kill_service "web" "$PIDFILE.web" "$(web_pids)"
  local port
  for port in "$API_PORT" "$WEB_PORT" "$SUPERVISOR_PORT"; do
    kill_port_listener "$port"
  done
  wait_for 10 port_free "$API_PORT" && wait_for 5 port_free "$WEB_PORT" \
    || echo "WARNING: some ports are still listening after stop"
  echo "postgres left as-is (its container/unit is managed separately)."
}

direct_status() {
  if port_listening "$SUPERVISOR_PORT" && supervisor_healthy; then
    record "PASS  supervisor (127.0.0.1:$SUPERVISOR_PORT)"
  else
    record "FAIL  supervisor — not running"
  fi
  if api_healthy; then
    record "PASS  api        (127.0.0.1:$API_PORT, /health ok)"
  else
    record "FAIL  api        — not running"
  fi
  if [[ -n "$(worker_service_pids)" ]]; then
    record "PASS  worker     (process alive)"
  else
    record "FAIL  worker     — not running"
  fi
  if web_healthy; then
    record "PASS  web        (http://localhost:$WEB_PORT)"
  else
    record "FAIL  web        — not running"
  fi
}

# --- dispatch ----------------------------------------------------------------
case "${1:-up}" in
  up)
    if using_systemd_stack; then sd_up; else
      check_postgres
      start_supervisor
      verify_supervisor_docker
      start_api
      start_worker
      start_web
    fi
    echo
    echo "================ DEV STACK ================"
    for r in "${RESULTS[@]}"; do echo "$r"; done
    echo "==========================================="
    echo "UI: http://localhost:$WEB_PORT   API: http://127.0.0.1:$API_PORT/health"
    if (( OVERALL )); then echo "VERDICT: NOT READY (see FAIL/BLOCKED above; logs in $LOGDIR)"; exit 1; fi
    echo "VERDICT: STACK UP"
    ;;
  status)
    if using_systemd_stack; then sd_status; else direct_status; check_postgres; fi
    for r in "${RESULTS[@]}"; do echo "$r"; done
    (( OVERALL )) && exit 1 || exit 0 ;;
  stop)
    if using_systemd_stack; then sd_stop; else direct_stop; fi ;;
  *) echo "usage: scripts/dev-stack.sh [up|status|stop]"; exit 2 ;;
esac
