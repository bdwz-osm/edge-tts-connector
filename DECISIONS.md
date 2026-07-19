# DECISIONS

## 2026-07-18 — Daemon v1 (build-order step 1)

- **Logging:** `run.sh start` redirects daemon stdout/stderr to `daemon/daemon.log` (gitignored). Not specified in plan; needed for crash diagnosis.
- **Queue depth:** `request_queue_max` counts distinct in-flight synth keys (after cache miss / coalesce), not raw HTTP connections. Coalesced waiters share one slot.
- **Pitch:** accept any `±NHz` matching the wire form; default `+0Hz`. Extension is expected to send `+0Hz` in v1.
- **Python without uv:** allow system `python3` with major.minor ≥ pin from `DEPENDENCIES.sh` (not only exact pin).
- **Error `attempts`:** included on synth error JSON whenever a `SynthError` is raised (including validation); harmless extra field vs rpc.md examples.
- **OPTIONS:** handled entirely in CORS middleware (no separate router entry).

## 2026-07-18 — Config TOML + ops UX

- **TOML over JSON:** sectioned `config.toml`; stdlib `tomllib` (3.11+). Plan docs updated.
- **No config.example.toml:** first start writes a full template (active `auth.secret`, other knobs commented by section).
- **OPTIONS schema:** `config.py` `OPTIONS` tuple is the single source for defaults, TOML paths, and generated `config.toml`; only the file header prose is fixed.
- **Secret repair:** if `config.toml` exists but `auth.secret` is missing/invalid/placeholder, inject a new secret under `[auth]` and warn (extension must be updated).
- **Config location:** repo-root `config.toml` (not under `daemon/`).
- **Sections:** `[auth]`, `[server]`, `[synth]`, `[cache]` with short keys (`timeout_s`, `retries`, `dir`, …) mapped to internal names in `config.py`.
- **venv path:** `daemon/venv` (not `.venv`).
- **Wrapper:** repo-root `server.sh` forwards to `daemon/run.sh`.
- **start output:** always prints secret + URL/pid/log paths so the extension can be configured without opening the file.

## 2026-07-18 — edge-tts errors, voices cache, retry budgets

- **Guide role:** `.spec/edge-tts-errors.md` is inventory only; product mapping lives in `.spec/rpc.md` (screen-reader calm: no thrash, offline banner, skip bad play chunk).
- **No daemon `wait_for` on synth:** removed `synth_timeout_s`; edge-tts owns socket timeouts; extension owns UX abandon. Late finishes may still fill MP3 cache.
- **`priority`:** `play` \| `prefetch` on `POST /v1/synth`. Play → config `retries`; prefetch → max 2 attempts.
- **HTTP 403 single mapping:** always wire `upstream_offline` + circuit clock/auth strike (never `upstream_reject`). Library may retry 403 once inside one `Communicate`; mass 403/`SkewAdjustmentError` → breaker 3 strikes / 5 min open.
- **Protocol (`UnexpectedResponse` / `UnknownResponse`):** no retry → `upstream_reject`.
- **Voices:** `daemon/voices-cache.json`; startup live then disk; `GET /voices` envelope + 503 `voices_unavailable`; background refresh backoff 5–30 min; `stale` if >24h; unknown voice 400 only when list fresh ≤24h.
- **SSL / skew:** treated as `upstream_offline` (unusable path to MS), not endless transient retry.

## 2026-07-18 — Daemon unit tests

- **Harness:** `pytest` + `pytest-asyncio` + `pytest-aiohttp` under `daemon/`; `daemon/pytest.ini` sets `pythonpath=.`, `testpaths=tests`. Dev deps in `daemon/requirements-dev.txt` (not runtime `requirements.txt`).
- **Scope:** unit/component tests for cache poison/LRU, config validation, exception classify/retry/circuit, synth validation, HTTP auth/CORS/routes with mocked TTS. No live Microsoft calls.
- **Not a build-order gate:** curl acceptance remains the step-1 bar; tests are optional local insurance.

## 2026-07-19 — pickRoot must not crown code blocks

- Flat pages (Beej’s Guide: no `article`/`main`, only `.sourceCode` divs + body children) made argmax `textLen - 2*linkText` pick the largest code wrapper (no links → high score). Reading started at first `<pre>`.
- Fix: body is the baseline score; candidates must beat body; skip code-ish roots (`.sourceCode`, `pre`, …); min textLen 200.

## 2026-07-19 — Blob URLs not in service worker

- Chrome MV3 SW has no `URL.createObjectURL`. Background keeps `Blob`; `audio/play` sends **base64** + mimeType to offscreen (Blob/ArrayBuffer messaging was unreliable). Offscreen decodes → Blob → object URL → play.
- Background must **not** return a Promise for outbound `audio/play|pause|…` messages — that steals the response channel from offscreen. Only handle `audio/ended|error|state` in the SW.

## 2026-07-19 — Chunk/popup review fixes

- **Leaf blocks only:** skip `BLOCK_SEL` nodes that contain another `BLOCK_SEL` (no blockquote/li double-read).
- **Selection anchor:** `getRangeAt(0).commonAncestorContainer` (not on `Selection`).
- **Fallback RFH:** when all `anchor: []`, map via visible-text offset in root (`nearestByTextOffset`).
- **visibleText:** already exclusion-aware; spec clarified (not visibility-only).
- **Popup:** try/catch on transport/settings messages; `applying` reset in `finally`.

## 2026-07-18 — Read path (steps 3–4 collapsed)

User chose full `reader.md` in one pass (not minimal-then-buffer).

- **Activate:** popup Play on active tab (inject → chunk → play).
- **UX timeouts:** play synth+audio fetch **45s**; prefetch **30s** (AbortController; ignore late).
- **Blob URLs:** created and revoked only in background; bridge clears `src` only.
- **Anchors:** `childIndexPath` = indices among **element children** only (not full childNodes).
- **Empty BLOCK_SEL:** fallback `splitSoft(visibleText(root))` with anchor `[]` (highlight may no-op).
- **Read From Here (cold):** no permanent content script — if selection, selection mode; else page from 0. If content already injected, uses last `contextmenu` target → nearest chunk.
- **Keepalive / shortcuts gate:** still polish (step 5); hooks exist, default off.

## 2026-07-18 — Firefox host_permissions without port

- Firefox does not honor ports in match patterns; `http://127.0.0.1:24765/*` does not grant fetch to the daemon.
- Firefox manifest: `http://127.0.0.1/*`. Chrome keeps `:24765`. Auth secret still required.

## 2026-07-18 — Friendly name: etc Speech

- **UI / store name:** `etc Speech` (manifest `name`, toolbar title, popup/options, context menu).
- **Not renamed:** repo path, package ids, gecko id `edge-tts-connector@local`, daemon logger/pidfile names, library `edge-tts`.

## 2026-07-18 — Extension shell (build-order step 2)

- **Stack:** TypeScript ES2022 + esbuild + `webextension-polyfill`. Build: `./rebuild_extensions.sh` or `cd extension && npm run build` → load `build/chrome/` or `build/firefox/`.
- **Sole RPC client:** background `rpc.ts` only; popup/options message bg (`popup/*`, `options/*`). Auth probe = `GET /health` then `GET /voices` (401 → bad secret; `voices_unavailable` still counts as secret-ok).
- **UI scope this step:** options secret + test connection; popup online/secret/restricted banner + options link. Play/transport controls present but disabled until step 3.
- **Stubs:** `content.ts`, `chunk.ts`, `offscreen.ts`/`audioBridge.ts`, context-menu handler no-op beyond restricted-URL guard.
- **Browser define:** esbuild `__BROWSER__` (`chrome`|`firefox`) for later AudioBridge split; Firefox build omits offscreen entry/html.
- **Output:** repo-root `build/{chrome,firefox}/` (gitignored with `extension/node_modules/`). Commit `package-lock.json`.
- **Loader script:** `./rebuild_extensions.sh` prints browser-specific load steps (Chromium Load unpacked / Firefox temporary add-on).

## 2026-07-18 — Rename `spec/` → `.spec/`

- Hidden dir so repo-root tab-complete reaches `server.sh` without competing with `spec/`. Paths updated in `AGENTS.md`, `project.md`, `README.md`, and code comments.
