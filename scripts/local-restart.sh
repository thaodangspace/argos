#!/usr/bin/env bash
#
# Rebuild this checkout and restart the local `argos serve`.
#
#   npm run local:restart                 # build CLI + UI, copy the UI, restart
#   npm run local:restart -- --tests      # also run the unit suite + typecheck
#   npm run local:restart -- --no-ui      # skip the UI build (reuse packages/cli/ui)
#   npm run local:restart -- --no-restart # build/install only
#   npm run local:restart -- --no-build   # restart the current dist
#
# Restart modes:
#   - launchd (default when ~/Library/LaunchAgents/<ARGOS_LAUNCHD_LABEL>.plist
#     exists): `launchctl kickstart -k`, so KeepAlive brings the rebuilt server
#     back and the job survives logout/reboot. The plist owns the environment.
#   - detached fallback: stop the pid from $ARGOS_HOME/serve.pid (or the port),
#     keep its ARGOS_PASEO_* environment, and start it under nohup.
# Either way the script waits for /ui (or /health) before reporting success.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

HOME_DIR="${ARGOS_HOME:-$HOME/.argos}"
PORT="${ARGOS_PORT:-7676}"
LOG_FILE="$HOME_DIR/serve.log"
MAX_LOG_BYTES=10485760
LAUNCHD_LABEL="${ARGOS_LAUNCHD_LABEL:-local.argos.serve}"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"

DO_BUILD=1
DO_UI=1
DO_RESTART=1
DO_TESTS=0
FORCE=0

usage() {
  sed -n '3,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Flags:
  --tests        run `npm test` and `npm run typecheck` before restarting
  --no-ui        skip the SvelteKit build; reuse the existing packages/cli/ui
  --no-restart   build and copy the UI, but leave the running server alone
  --no-build     skip the build; just restart the current dist/build
  --force        stop whatever listens on the port, even if it is not argos
  --port <n>     port to probe/start (default: ARGOS_PORT or 7676)
  --home <dir>   ARGOS_HOME to use (default: ~/.argos)
  -h, --help     this help
EOF
}

say() { printf '[local-restart] %s\n' "$*"; }
die() { printf '[local-restart] error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tests) DO_TESTS=1 ;;
    --no-ui) DO_UI=0 ;;
    --no-restart) DO_RESTART=0 ;;
    --no-build) DO_BUILD=0 ;;
    --force) FORCE=1 ;;
    --port) [ $# -ge 2 ] || die "--port needs a value"; PORT="$2"; shift ;;
    --home) [ $# -ge 2 ] || die "--home needs a value"; HOME_DIR="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag: $1 (try --help)" ;;
  esac
  shift
done

LOG_FILE="$HOME_DIR/serve.log"
[ -d "$HOME_DIR" ] || die "ARGOS_HOME $HOME_DIR does not exist; start the server once first"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || die "node not found on PATH"

# ---------------------------------------------------------------- helpers

# The pid of the running server: the pid file first, then whoever listens on the port.
find_server_pid() {
  local pid=""
  if [ -f "$HOME_DIR/serve.pid" ]; then
    pid="$(tr -dc '0-9' < "$HOME_DIR/serve.pid" 2>/dev/null || true)"
  fi
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    printf '%s' "$pid"
    return 0
  fi
  pid="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  printf '%s' "$pid"
}

launchd_loaded() {
  launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1
}

is_argos_server() {
  local pid="$1"
  # Either the shipped bin (`argos serve`) or the checkout entry this script starts.
  ps -o command= -p "$pid" 2>/dev/null \
    | grep -Eq '(^| )(argos serve|.*/argos/packages/cli/dist/index\.js serve|.*/packages/cli/dist/index\.js serve)$'
}

# The ARGOS_PASEO_* variables the running server was started with (never printed).
# The caller's environment wins when it already sets one.
capture_environment() {
  local pid="$1"
  CARRIED_ENV=()
  [ -n "$pid" ] || return 0
  local entry name
  for entry in $(ps eww -p "$pid" 2>/dev/null | tr ' ' '\n' | grep -E '^ARGOS_(PASEO_URL|PASEO_PASSWORD|EXECUTOR)=' || true); do
    name="${entry%%=*}"
    if [ -n "${!name:-}" ]; then
      continue
    fi
    CARRIED_ENV+=("$entry")
  done
}

rotate_log() {
  if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE" | tr -d ' ')" -gt "$MAX_LOG_BYTES" ]; then
    mv "$LOG_FILE" "$LOG_FILE.1"
    say "rotated $LOG_FILE → $LOG_FILE.1"
  fi
}

wait_for_http() {
  local path="$1"
  local token=""
  [ -f "$HOME_DIR/token" ] && token="$(tr -d '\n' < "$HOME_DIR/token")"
  local deadline=$(( $(date +%s) + 20 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -n "$token" ]; then
      if curl -fsS -o /dev/null -H "Authorization: Bearer $token" "http://127.0.0.1:$PORT$path" 2>/dev/null; then
        return 0
      fi
    elif curl -fsS -o /dev/null "http://127.0.0.1:$PORT$path" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

show_status() {
  [ -f "$HOME_DIR/token" ] || return 0
  local token
  token="$(tr -d '\n' < "$HOME_DIR/token")"
  curl -fsS -H "Authorization: Bearer $token" "http://127.0.0.1:$PORT/info" 2>/dev/null \
    | "$NODE_BIN" -e '
        let raw = "";
        process.stdin.on("data", (chunk) => (raw += chunk));
        process.stdin.on("end", () => {
          try {
            const info = JSON.parse(raw);
            const executors = (info.executors ?? []).map((entry) => entry.id).join(", ");
            console.log(`[local-restart] pid ${info.pid} · port ${info.port} · executors ${executors || "?"}`);
          } catch {
            /* not fatal: the server answered but the shape changed */
          }
        });
      ' || true
}

# ---------------------------------------------------------------- build

if [ "$DO_BUILD" = 1 ]; then
  say "building core + cli (tsc -b)"
  npm run build
  if [ "$DO_UI" = 1 ]; then
    say "building UI (sveltekit)"
    npm run build:ui
    say "copying UI into packages/cli/ui"
    node packages/cli/scripts/copy-ui.mjs
  else
    say "UI build skipped (--no-ui)"
  fi
fi

if [ "$DO_TESTS" = 1 ]; then
  say "running unit suite"
  npm test
  say "typecheck"
  npm run typecheck
fi

if [ "$DO_RESTART" = 0 ]; then
  say "build complete; server left running (--no-restart)"
  exit 0
fi

# ---------------------------------------------------------------- restart

if launchd_loaded || [ -f "$LAUNCHD_PLIST" ]; then
  if ! launchd_loaded; then
    say "loading launchd job $LAUNCHD_LABEL"
    launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST" \
      || die "could not load $LAUNCHD_PLIST"
    launchctl enable "gui/$(id -u)/$LAUNCHD_LABEL" || true
  fi
  say "restarting launchd job $LAUNCHD_LABEL (KeepAlive)"
  # launchd owns the log file descriptor, so rotating it here would split the log.
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL" \
    || die "launchctl kickstart failed for $LAUNCHD_LABEL"
  NEW_PID=""
  LAUNCHD=1
else
  OLD_PID="$(find_server_pid)"
  if [ -n "$OLD_PID" ]; then
    if ! is_argos_server "$OLD_PID" && [ "$FORCE" != 1 ]; then
      die "pid $OLD_PID on port $PORT is not an argos server; rerun with --force to replace it"
    fi
    capture_environment "$OLD_PID"
    say "stopping pid $OLD_PID"
    kill -TERM "$OLD_PID" 2>/dev/null || true
    for _ in $(seq 1 40); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$OLD_PID" 2>/dev/null; then
      say "pid $OLD_PID ignored SIGTERM; sending SIGKILL"
      kill -9 "$OLD_PID" 2>/dev/null || true
      sleep 0.5
    fi
  else
    capture_environment ""
    say "no running server found on port $PORT; starting one"
  fi

  # A stale listener (something else, or a killed process that has not exited) would
  # make the new server fail to bind; report that instead of a silent restart.
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    die "port $PORT is still in use; rerun with --force if it is a stray argos server"
  fi

  rotate_log
  say "starting argos serve (port $PORT, log $LOG_FILE)"
  if [ ${#CARRIED_ENV[@]} -gt 0 ]; then
    nohup env "${CARRIED_ENV[@]}" "$NODE_BIN" "$REPO_ROOT/packages/cli/dist/index.js" serve \
      >> "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup "$NODE_BIN" "$REPO_ROOT/packages/cli/dist/index.js" serve \
      >> "$LOG_FILE" 2>&1 < /dev/null &
  fi
  NEW_PID=$!
  disown || true
  LAUNCHD=0
fi

CHECK_PATH="/health"
[ -f "$REPO_ROOT/packages/cli/ui/index.html" ] && CHECK_PATH="/ui/"
if ! wait_for_http "$CHECK_PATH"; then
  say "server did not answer $CHECK_PATH within 20s; last log lines:"
  tail -n 15 "$LOG_FILE" >&2 || true
  exit 1
fi

if [ "$LAUNCHD" = 1 ]; then
  for _ in $(seq 1 20); do
    NEW_PID="$(tr -dc '0-9' < "$HOME_DIR/serve.pid" 2>/dev/null || true)"
    [ -n "$NEW_PID" ] && kill -0 "$NEW_PID" 2>/dev/null && break
    sleep 0.25
  done
fi
say "server is up (pid ${NEW_PID:-?}, launchd=$LAUNCHD)"
grep -E '^\[argos\] ' "$LOG_FILE" | tail -n 3 || true
show_status
if [ "$DO_UI" = 1 ]; then
  say "UI: http://127.0.0.1:$PORT/ui/"
fi
