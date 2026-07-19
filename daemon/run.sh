#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/DEPENDENCIES.sh"

VENV="$ROOT/venv"
PIDFILE="$ROOT/edge-tts-connector.pid"
CONFIG="$REPO_ROOT/config.toml"
HOST="127.0.0.1"
PORT="24765"
REQS="$ROOT/requirements.txt"
LOGFILE="$ROOT/daemon.log"

log() { printf '%s\n' "$*" >&2; }

read_secret() {
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  CONFIG_PATH="$CONFIG" python - <<'PY'
import os
from pathlib import Path
from config import read_secret
print(read_secret(Path(os.environ["CONFIG_PATH"])))
PY
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$PORT )" 2>/dev/null | tail -n +2 | grep -q .
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1
    return $?
  fi
  if [[ -x "$VENV/bin/python" ]]; then
    "$VENV/bin/python" - "$HOST" "$PORT" <<'PY'
import socket, sys
host, port = sys.argv[1], int(sys.argv[2])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.bind((host, port))
except OSError:
    sys.exit(0)
else:
    sys.exit(1)
finally:
    s.close()
PY
    return $?
  fi
  return 1
}

ensure_venv() {
  local major minor want_mm py pin_maj pin_min
  want_mm="${PYTHON_VERSION%.*}"
  pin_maj="${want_mm%%.*}"
  pin_min="${want_mm#*.}"

  if command -v uv >/dev/null 2>&1; then
    if [[ ! -d "$VENV" ]]; then
      log "→ Installing Python $PYTHON_VERSION via uv…"
      uv python install "$PYTHON_VERSION"
      uv venv --python "$PYTHON_VERSION" "$VENV"
      log "→ Created venv at $VENV"
    else
      log "→ Using venv $VENV"
    fi
    # shellcheck disable=SC1091
    source "$VENV/bin/activate"
    log "→ Installing Python dependencies…"
    uv pip install -r "$REQS"
    return 0
  fi

  py="$(command -v python3 || true)"
  if [[ -z "$py" ]]; then
    log "error: need uv or python3"
    exit 1
  fi
  major="$("$py" -c 'import sys; print(sys.version_info[0])')"
  minor="$("$py" -c 'import sys; print(sys.version_info[1])')"
  if (( major < pin_maj || (major == pin_maj && minor < pin_min) )); then
    log "error: python3 is $major.$minor; need >= $want_mm (or install uv)"
    exit 1
  fi

  if [[ ! -d "$VENV" ]]; then
    log "→ Creating venv with $py at $VENV…"
    "$py" -m venv "$VENV"
  else
    log "→ Using venv $VENV"
  fi
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  log "→ Installing Python dependencies…"
  python -m pip install -U pip
  python -m pip install -r "$REQS"
}

ensure_config() {
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  log "→ Config $CONFIG"
  CONFIG_PATH="$CONFIG" python - <<'PY'
import os
from pathlib import Path
from config import ensure_config, print_secret_event

result = ensure_config(Path(os.environ["CONFIG_PATH"]))
if result.secret_generated:
    kind = "created" if result.created else "injected"
    print_secret_event(kind, result.secret, Path(os.environ["CONFIG_PATH"]))
PY
}

print_status() {
  local pid="$1"
  local secret
  secret="$(read_secret)"
  log ""
  log "edge-tts-connector daemon"
  log "  status  running"
  log "  pid     $pid"
  log "  url     http://${HOST}:${PORT}"
  log "  health  http://${HOST}:${PORT}/health"
  log "  config  $CONFIG"
  log "  secret  $secret"
  log "  log     $LOGFILE"
  log ""
  log "Put the secret in the extension options (X-Auth-Token)."
  log "Stop with: $0 stop"
}

cmd_start() {
  log "Starting edge-tts-connector daemon…"
  ensure_venv
  cd "$ROOT"
  ensure_config

  if [[ -f "$PIDFILE" ]]; then
    local old
    old="$(tr -d ' \n' <"$PIDFILE" || true)"
    if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
      log "Already running (pid $old)."
      print_status "$old"
      exit 0
    fi
    rm -f "$PIDFILE"
  fi

  if port_in_use; then
    log "error: port $PORT already in use on $HOST"
    exit 1
  fi

  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  log "→ Binding http://${HOST}:${PORT}…"
  nohup python server.py --config "$CONFIG" --pidfile "$PIDFILE" \
    >>"$LOGFILE" 2>&1 &
  local boot_pid=$!

  local i
  for i in $(seq 1 50); do
    if curl -sf "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
      local pid
      pid="$(tr -d ' \n' <"$PIDFILE" 2>/dev/null || true)"
      print_status "${pid:-$boot_pid}"
      return 0
    fi
    if ! kill -0 "$boot_pid" 2>/dev/null; then
      log "error: daemon exited during startup; see $LOGFILE"
      exit 1
    fi
    sleep 0.1
  done
  log "error: daemon did not become healthy; see $LOGFILE"
  kill "$boot_pid" 2>/dev/null || true
  exit 1
}

cmd_stop() {
  if [[ ! -f "$PIDFILE" ]]; then
    log "Daemon not running."
    return 0
  fi
  local pid
  pid="$(tr -d ' \n' <"$PIDFILE" || true)"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PIDFILE"
    log "Daemon not running."
    return 0
  fi
  log "Stopping daemon (pid $pid)…"
  kill -TERM "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PIDFILE"
      log "Stopped."
      return 0
    fi
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
  log "Stopped (killed)."
}

usage() {
  log "usage: $0 {start|stop}"
  exit 2
}

main() {
  local cmd="${1:-start}"
  case "$cmd" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    *) usage ;;
  esac
}

main "$@"
