#!/usr/bin/env bash
# Build etc Speech browser extensions into ./build/{chrome,firefox}/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$ROOT/extension"
BUILD="$ROOT/build"

die() { echo "error: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is required (https://nodejs.org/)"
command -v npm >/dev/null 2>&1 || die "npm is required"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  die "Node.js 18+ required (found $(node -v))"
fi

echo "→ etc Speech extension build"
echo "  source  $EXT"
echo "  output  $BUILD/{chrome,firefox}/"
echo

cd "$EXT"
if [[ ! -d node_modules ]]; then
  echo "→ npm install (first time)…"
  npm install
else
  echo "→ npm install (ensure deps)…"
  npm install --silent
fi

echo "→ building Chromium + Firefox bundles…"
npm run build

# Sanity: manifests must exist
[[ -f "$BUILD/chrome/manifest.json" ]] || die "missing $BUILD/chrome/manifest.json"
[[ -f "$BUILD/firefox/manifest.json" ]] || die "missing $BUILD/firefox/manifest.json"

CHROME_PATH="$BUILD/chrome"
FIREFOX_PATH="$BUILD/firefox"

cat <<EOF

✓ Build complete.

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

  Docs: https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked
        https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/
────────────────────────────────────────────────────────────
EOF
