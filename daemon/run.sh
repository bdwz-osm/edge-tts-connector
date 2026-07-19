#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/DEPENDENCIES.sh"

VENV="$ROOT/venv"
# Records how the venv was built so --use-uv / --use-python / pin bumps recreate it.
VENV_META="$VENV/.etc-speech-venv"
PIDFILE="$ROOT/edge-tts-connector.pid"
CONFIG="$REPO_ROOT/config.toml"
HOST="127.0.0.1"
PORT="24765"
REQS="$ROOT/requirements.txt"
LOGFILE="$ROOT/daemon.log"
# auto | uv | python  — set via --use-uv / --use-python
PYTHON_BACKEND="auto"

log() { printf '%s\n' "$*" >&2; }

# True if version A >= version B (dotted numerics; strips leading v).
version_ge() {
  local a="${1#v}" b="${2#v}"
  [[ "$(printf '%s\n' "$a" "$b" | sort -V | tail -n1)" == "$a" ]]
}

# major.minor from PYTHON_VERSION (3.14 or 3.14.0 → 3.14)
python_want_mm() {
  local maj min rest
  maj="${PYTHON_VERSION%%.*}"
  rest="${PYTHON_VERSION#*.}"
  min="${rest%%.*}"
  printf '%s.%s' "$maj" "$min"
}

# Fail unless active `python` is >= PYTHON_VERSION major.minor.
assert_python_version() {
  local got want
  want="$(python_want_mm)"
  got="$(python -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
  if ! version_ge "$got.0" "$want.0"; then
    log "error: python is $got; need >= $want (PYTHON_VERSION=$PYTHON_VERSION in DEPENDENCIES.sh)"
    exit 1
  fi
  log "→ Python $got (pin >= $want)"
}

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

# Effective backend after resolving "auto".
# auto keeps a stamped, still-valid venv (does not yank --use-python → uv).
# Explicit --use-uv / --use-python always wins and may recreate.
resolve_python_backend() {
  local want_mm have_backend have_py
  want_mm="$(python_want_mm)"

  case "$PYTHON_BACKEND" in
    uv|python)
      printf '%s' "$PYTHON_BACKEND"
      return
      ;;
    auto) ;;
    *)
      log "error: internal: bad PYTHON_BACKEND=$PYTHON_BACKEND"
      exit 1
      ;;
  esac

  if [[ -x "$VENV/bin/python" && -f "$VENV_META" ]]; then
    have_backend="$(read_venv_meta_field backend || true)"
    have_py="$(read_venv_meta_field python || true)"
    if [[ -n "$have_backend" && -n "$have_py" ]] && version_ge "$have_py.0" "$want_mm.0"; then
      if [[ "$have_backend" == "uv" ]] && command -v uv >/dev/null 2>&1; then
        printf 'uv'
        return
      fi
      if [[ "$have_backend" == "python" ]]; then
        printf 'python'
        return
      fi
    fi
  fi

  if command -v uv >/dev/null 2>&1; then
    printf 'uv'
  else
    printf 'python'
  fi
}

write_venv_meta() {
  local backend="$1" py_mm="$2"
  mkdir -p "$VENV"
  cat >"$VENV_META" <<EOF
backend=$backend
python=$py_mm
pin=$PYTHON_VERSION
EOF
}

read_venv_meta_field() {
  local key="$1"
  [[ -f "$VENV_META" ]] || return 1
  # shellcheck disable=SC1090
  grep -E "^${key}=" "$VENV_META" 2>/dev/null | head -1 | cut -d= -f2-
}

# Drop venv if missing, unstamped, wrong backend, or wrong python major.minor.
venv_needs_recreate() {
  local want_backend="$1" want_py="$2"
  local have_backend have_py

  if [[ ! -d "$VENV" || ! -x "$VENV/bin/python" ]]; then
    return 0
  fi
  if [[ ! -f "$VENV_META" ]]; then
    log "→ venv has no stamp (legacy); will recreate"
    return 0
  fi
  have_backend="$(read_venv_meta_field backend || true)"
  have_py="$(read_venv_meta_field python || true)"
  if [[ "$have_backend" != "$want_backend" ]]; then
    log "→ venv backend is '$have_backend', want '$want_backend'; will recreate"
    return 0
  fi
  if [[ "$have_py" != "$want_py" ]]; then
    log "→ venv python is $have_py, want $want_py; will recreate"
    return 0
  fi
  return 1
}

recreate_venv_dir() {
  # Running daemon holds files under venv/; stop first.
  if [[ -f "$PIDFILE" ]]; then
    local pid
    pid="$(tr -d ' \n' <"$PIDFILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      log "→ Stopping daemon before recreating venv…"
      cmd_stop
    fi
  fi
  if [[ -d "$VENV" ]]; then
    log "→ Removing old venv $VENV"
    rm -rf "$VENV"
  fi
}

ensure_venv_uv() {
  local want_mm
  want_mm="$(python_want_mm)"

  command -v uv >/dev/null 2>&1 || {
    log "error: uv not found (https://github.com/astral-sh/uv)"
    exit 1
  }

  if venv_needs_recreate "uv" "$want_mm"; then
    recreate_venv_dir
    log "→ Installing Python $PYTHON_VERSION via uv…"
    uv python install "$PYTHON_VERSION"
    uv venv --python "$PYTHON_VERSION" "$VENV"
    write_venv_meta "uv" "$want_mm"
    log "→ Created venv at $VENV (uv, python $want_mm)"
  else
    log "→ Using venv $VENV (uv, python $want_mm)"
  fi
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  assert_python_version
  log "→ Installing Python dependencies (uv pip)…"
  uv pip install -r "$REQS"
}

ensure_venv_python() {
  local want_mm py got
  want_mm="$(python_want_mm)"

  py="$(command -v python3 || true)"
  if [[ -z "$py" ]]; then
    log "error: python3 not found"
    exit 1
  fi
  got="$("$py" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')"
  if ! version_ge "$got.0" "$want_mm.0"; then
    log "error: python3 is $got; need >= $want_mm (PYTHON_VERSION=$PYTHON_VERSION)"
    log "       or: ./server.sh --use-uv start"
    exit 1
  fi

  # Stamp the interpreter we actually bind (system major.minor).
  if venv_needs_recreate "python" "$got"; then
    recreate_venv_dir
    log "→ Creating venv with $py ($got) at $VENV…"
    "$py" -m venv "$VENV"
    write_venv_meta "python" "$got"
  else
    log "→ Using venv $VENV (python/pip, $got)"
  fi
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  assert_python_version
  log "→ Installing Python dependencies (pip)…"
  python -m pip install -U pip
  python -m pip install -r "$REQS"
}

ensure_venv() {
  local effective
  effective="$(resolve_python_backend)"
  case "$effective" in
    uv) ensure_venv_uv ;;
    python) ensure_venv_python ;;
    *)
      log "error: internal: bad backend $effective"
      exit 1
      ;;
  esac
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
  log "Put the secret in the extension Options (X-Auth-Token)."
  log ""
  log "Browser extension (if you have not loaded it yet):"
  log "  ./rebuild_extensions.sh            # Bun if present, else Node"
  log "  ./rebuild_extensions.sh --use-node # force Node 18+"
  log "  → build/chrome/   Chromium / Vivaldi / Edge  (Load unpacked)"
  log "  → build/firefox/  Firefox  (about:debugging → Load Temporary Add-on)"
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
  cat <<EOF >&2
usage: $0 [options] {start|stop}

  start   ensure venv/deps, write config if needed, bind :$PORT
  stop    stop daemon via pidfile

options (before or after the command):
  --use-uv       force uv (recreates venv if it was built with python)
  --use-python   force system python3 + pip (recreates if it was built with uv)
  (default)      keep existing stamped venv if still valid; else uv if present, else python3

examples:
  $0 start
  $0 --use-python start
  $0 start --use-uv
  $0 stop
EOF
  exit 2
}

main() {
  local cmd=""
  local args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --use-uv) PYTHON_BACKEND="uv"; shift ;;
      --use-python) PYTHON_BACKEND="python"; shift ;;
      -h|--help) usage ;;
      start|stop)
        if [[ -n "$cmd" ]]; then
          log "error: multiple commands"
          usage
        fi
        cmd="$1"
        shift
        ;;
      *)
        log "error: unknown argument: $1"
        usage
        ;;
    esac
  done

  cmd="${cmd:-start}"
  case "$cmd" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    *) usage ;;
  esac
}

main "$@"
