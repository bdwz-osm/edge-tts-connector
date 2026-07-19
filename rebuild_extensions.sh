#!/usr/bin/env bash
# Build etc Speech browser extensions into ./build/{chrome,firefox}/
# Default: Bun if available, else Node. Versions from DEPENDENCIES.sh.
# Force:  --use-bun | --use-node
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$ROOT/extension"
BUILD="$ROOT/build"

# shellcheck source=/dev/null
source "$ROOT/DEPENDENCIES.sh"

die() { echo "error: $*" >&2; exit 1; }

usage() {
  cat <<EOF
usage: $0 [--use-bun | --use-node]

  --use-bun   force Bun (Node API >= NODE_VERSION from DEPENDENCIES.sh)
  --use-node  force Node.js (>= NODE_VERSION) + npm
  (default)   Bun if on PATH, otherwise Node

Pins (DEPENDENCIES.sh):
  NODE_VERSION=$NODE_VERSION

EOF
  exit 2
}

# True if version A >= version B (numeric dotted, ignores leading v).
version_ge() {
  local a="${1#v}" b="${2#v}"
  [[ "$(printf '%s\n' "$a" "$b" | sort -V | tail -n1)" == "$a" ]]
}

# Normalize "v22.22.3" / "22.22.3" → 22.22.3
strip_v() { printf '%s' "${1#v}"; }

JS_BACKEND="auto"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --use-bun)  JS_BACKEND="bun"; shift ;;
    --use-node) JS_BACKEND="node"; shift ;;
    -h|--help)  usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

require_node_version() {
  local got raw
  raw="$(node -p "process.versions.node" 2>/dev/null)" || die "could not read node version"
  got="$(strip_v "$raw")"
  version_ge "$got" "$NODE_VERSION" || \
    die "Node.js >= $NODE_VERSION required (found v$got). Bump NODE_VERSION in DEPENDENCIES.sh or upgrade Node."
}

# Bun only needs to run install + esbuild.config.mjs. We still check the
# Node API level it reports against NODE_VERSION (esbuild's floor).
require_bun_node_api() {
  local bun_node
  bun_node="$(bun -p "process.versions.node" 2>/dev/null || true)"
  [[ -n "$bun_node" ]] || return 0
  bun_node="$(strip_v "$bun_node")"
  version_ge "$bun_node" "$NODE_VERSION" || \
    die "Bun reports Node $bun_node; need Node API >= $NODE_VERSION (NODE_VERSION in DEPENDENCIES.sh)."
}

pick_bun() {
  command -v bun >/dev/null 2>&1 || die "bun not found (https://bun.sh)"
  require_bun_node_api
  RUNTIME="bun $(bun -v 2>/dev/null || true) (node-api $(bun -p "process.versions.node" 2>/dev/null || echo '?'))"
  INSTALLER="bun"
  RUNNER=(bun)
}

pick_node() {
  command -v node >/dev/null 2>&1 || die "node not found (https://nodejs.org/)"
  command -v npm >/dev/null 2>&1 || die "npm not found"
  require_node_version
  RUNTIME="node v$(node -p "process.versions.node") + npm"
  INSTALLER="npm"
  RUNNER=(node)
}

case "$JS_BACKEND" in
  bun)  pick_bun ;;
  node) pick_node ;;
  auto)
    if command -v bun >/dev/null 2>&1; then
      pick_bun
    else
      pick_node
    fi
    ;;
esac

echo "→ etc Speech extension build"
echo "  backend ${JS_BACKEND}"
echo "  runtime $RUNTIME"
echo "  pins    NODE>=$NODE_VERSION"
echo "  source  $EXT"
echo "  output  $BUILD/{chrome,firefox}/"
echo

cd "$EXT"

if [[ "$INSTALLER" == "bun" ]]; then
  echo "→ bun install…"
  bun install
else
  echo "→ npm install…"
  if [[ ! -d node_modules ]]; then
    npm install
  else
    npm install --silent
  fi
fi

echo "→ building Chromium + Firefox…"
"${RUNNER[@]}" esbuild.config.mjs chrome
"${RUNNER[@]}" esbuild.config.mjs firefox

[[ -f "$BUILD/chrome/manifest.json" ]] || die "missing $BUILD/chrome/manifest.json"
[[ -f "$BUILD/firefox/manifest.json" ]] || die "missing $BUILD/firefox/manifest.json"

CHROME_PATH="$BUILD/chrome"
FIREFOX_PATH="$BUILD/firefox"

cat <<EOF

✓ Build complete.  (via $RUNTIME)

  Chromium / Chrome / Vivaldi / Edge (Chromium)
    $CHROME_PATH

  Firefox
    $FIREFOX_PATH

────────────────────────────────────────────────────────────
  How to load (unpacked / temporary)

  Chromium family (Chrome, Vivaldi, Brave, Edge, …)
    1. Open  chrome://extensions
       (Vivaldi: vivaldi://extensions · Edge: edge://extensions)
    2. Turn ON  Developer mode  (top-right toggle).
    3. Click  Load unpacked
    4. Select this folder (the one that contains manifest.json):
         $CHROME_PATH
    5. After rebuilds: click the extension’s  Reload  (↻) on that page.
       Also refresh any tab you were reading (content script is old until then).

  Firefox
    1. Open  about:debugging#/runtime/this-firefox
    2. Click  Load Temporary Add-on…
    3. Open any file inside:
         $FIREFOX_PATH
       (e.g. manifest.json) — Firefox uses that folder as the extension root.
    4. Temporary add-ons are removed when Firefox quits; load again after restart.
    5. After rebuilds: click  Reload  next to the add-on on the debugging page,
       then refresh the page you were reading.

  First-time setup
    • Start the daemon:  ./server.sh start
    • Open extension Options and paste the printed auth secret.
    • Popup → Play on a normal https page.

  Force a toolchain
    • ./rebuild_extensions.sh --use-bun
    • ./rebuild_extensions.sh --use-node
    • Pins: DEPENDENCIES.sh (NODE_VERSION)

  Docs: https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked
        https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/
────────────────────────────────────────────────────────────
EOF
