# edge-tts-connector

Local screen-reader-style TTS for Chromium + Firefox. Extension never hits the net for TTS. Loopback Python daemon runs `edge-tts` (→ Microsoft), caches MP3s, serves RPC + audio.

## Spec map

| Doc | Contents |
|-----|----------|
| **this file** | goals, architecture, daemon ops, defaults, build order |
| [`.spec/rpc.md`](.spec/rpc.md) | HTTP wire + curl examples + extension message types + error/retry map |
| [`.spec/reader.md`](.spec/reader.md) | chunk algorithm, session state machine, buffer/highlight |
| [`.spec/extension.md`](.spec/extension.md) | manifests, build, AudioBridge, settings/UI |
| [`.spec/edge-tts-errors.md`](.spec/edge-tts-errors.md) | library exception inventory (reference only) |

Implement against **project + rpc + reader + extension**. If conflict: `project.md` wins on product intent; wire details win in `.spec/rpc.md` et al. `edge-tts-errors.md` is not product law — use it to avoid thrashing/mis-handling library failures.

## Goals / non-goals

**In:** dark popup; deterministic chunking; buffer-ahead; highlight; optional shortcuts; selection; context “Read From Here”; one active tab; discrete gen speed + free playback speed; client volume; lang-filtered voices; shared-secret loopback HTTP; LRU cache; smart daemon retries; `run.sh start|stop`; pinned Python via `DEPENDENCIES.sh`.

**Out:** cloud backend; `file://` / page `<audio>`; multi-tab sessions; full a11y SR; offline models; DRM bypass; PDF/chrome-privileged pages; word-level highlight (v2); systemd hard dependency; dumping TTS UX knobs into daemon config.

## Layout

```
project.md
.spec/rpc.md  .spec/reader.md  .spec/extension.md
README.md
DEPENDENCIES.sh              # PYTHON_VERSION=… (manual bump)
server.sh                    # → daemon/run.sh start|stop
config.toml                  # runtime ops config (gitignore)
daemon/
  run.sh  requirements.txt
  server.py  tts.py  cache.py  config.py
  voices-cache.json          # runtime gitignore
  venv/  edge-tts-connector.pid
extension/                   # see .spec/extension.md → dist/chrome|firefox/
tts-cache/<voice>/<hash>.mp3
```

## Architecture

```
[content] ←msg→ [background] ←msg→ [AudioBridge]
                    ↓ HTTP 127.0.0.1:24765 + X-Auth-Token
               [daemon aiohttp]
                    ↓ workers 1–3 + classify/retry
               edge-tts → tts-cache/<voice>/<md5>.mp3
```

- Playback **only** in extension (Chrome offscreen / FF bg `Audio`). Content: anchors, highlight, scroll, toasts for **current** chunk only.
- Audio: auth `fetch` → `blob:` URL (never secret in `src`). Details: `.spec/rpc.md`.
- Port **24765** fixed both sides; host always `127.0.0.1` (not `localhost`).

### Knob ownership

| Knob | Owner |
|------|--------|
| secret, workers, cache cap, retries, min_audio_bytes | daemon `config.toml` |
| port/host | hardcoded v1 |
| UX timeouts (play/prefetch abandon) | extension |
| voice, lang, gen speed, volume, playback speed, keepalive, buffers | extension settings |
| pitch | fixed `+0Hz` on wire v1; still in cache hash |
| `default_voice` in daemon config | API fallback if body omits voice only |

## Daemon

### DEPENDENCIES.sh + run.sh

```bash
# DEPENDENCIES.sh — bump manually
PYTHON_VERSION=3.12.8
```

`./server.sh start|stop` (default start; wraps `daemon/run.sh`). Sources `../DEPENDENCIES.sh`.

**start:** uv → `uv python install` + `uv venv --python $PYTHON_VERSION` at `daemon/venv`; else `python3` major.minor ≥ pin, `python3 -m venv`. Install reqs (`uv pip`|`pip`). Ensure repo-root `config.toml` (`0600`): create full commented template with generated `[auth].secret` if missing; if present but secret missing/invalid, inject a new secret and warn. Print secret on start. Pidfile after bind. Port busy → hard fail.

**stop:** pidfile TERM→KILL; friendly no-op. Optional later: example user unit (no systemd runtime dep).

### config.toml (ops-only, repo root)

Sectioned TOML. **Required:** `[auth].secret`. All other knobs are code defaults; the generated file lists them commented under `[server]`, `[synth]`, `[cache]`.

```toml
[auth]
secret = "<generated>"

[server]
# host = "127.0.0.1"
# port = 24765

[synth]
# workers = 2
# retries = 3
# retry_backoff_s = [0.5, 1.5, 3.0]
# …

[cache]
# dir = "tts-cache"
# …
```

Reject non-loopback host; workers ∈ [1,3]. **No daemon synth wall-clock timeout** (`synth_timeout_s` removed) — trust edge-tts connect/read timeouts; extension owns abandon/UX timeouts.

### Runtime rules

- **Voices:** startup live `list_voices()` → on success write `daemon/voices-cache.json` + memory; on failure load disk cache. `GET /voices` envelope + `voices_unavailable` in [`.spec/rpc.md`](.spec/rpc.md). Background recache while failing: backoff 5 min … 30 min cap. `stale` when data older than 24h (warn in UI after startup refresh attempt).
- **Voice gate:** if in-memory list is fresh (≤24h) and non-empty, unknown ShortName → 400; otherwise allow any well-formed ShortName.
- Synth: one new `Communicate` per attempt (`rate`, `pitch`, `volume="+0%"`). Rate discrete **−50%…+100%** step 10%; pitch default `+0Hz`. Body `priority`: `play` \| `prefetch`.
- **No poison cache:** write `*.part` only; unlink on fail; rename only if bytes ≥ `min_audio_bytes` and not `NoAudioReceived`; purge existing too-small finals; never `ready` without good final file.
- **Errors/retries:** typed classify + budgets + circuit breaker in [`.spec/rpc.md`](.spec/rpc.md). Play uses config `retries`; prefetch max 2 attempts. Do not `wait_for` around edge-tts. Coalesce in-flight by cache id. Parallel synth requests OK (worker semaphore).
- Cache path: `tts-cache/<voice>/<md5(rate,pitch,text)>.mp3` — formula in `.spec/rpc.md`. LRU by mtime to cap. Semaphore(workers).
- Routes/CORS/auth/Voice DTO: **`.spec/rpc.md` only**. Library oddities: [`.spec/edge-tts-errors.md`](.spec/edge-tts-errors.md) reference only.

## Extension (summary)

Full detail: [`.spec/extension.md`](.spec/extension.md), [`.spec/reader.md`](.spec/reader.md).

- MV3 Chrome + Firefox; inject on activate; refuse privileged/PDF URLs; main frame only.
- Lang list from voices present only; `Intl.DisplayNames`; voice = `ShortName` id.
- Gen speed stepped (resynth + hash); playback speed = `playbackRate` live; volume live.
- One session; buffer 1 behind / 8 ahead; skip on exhausted 502 for current chunk; prefetch silent (`priority: "prefetch"`).
- Extension may run multiple `/v1/synth` in parallel; apply UX timeouts client-side; ignore/abandon late results without requiring daemon cancel.
- `audioKeepalive` default off; safe toggle.

## Failure UX

| Case | UI |
|------|-----|
| Daemon down | offline banner |
| 401 | bad secret |
| 503 `voices_unavailable` | voice picker error; keep last-known settings; reading still possible via ShortName if gate off |
| `stale: true` voices | warn in options/popup (non-blocking) |
| 503 upstream_offline | pause + banner (play chunk); prefetch silent |
| 502 upstream_reject / exhausted transient | toast current; skip next; prefetch silent |
| 503 busy | prefetch silent; play retry once client-side |
| Restricted/PDF | refuse |
| Empty text | message |
| Nav/tab close | destroy session, revoke blobs |

## Threats

Local+secret abuse (accepted); `/health` open; CORS extension-origin only; no partial finals; never non-loopback; no secret/body text in logs.

## Build order

1. **Daemon** — DEPENDENCIES, run.sh, config/secret, routes per `.spec/rpc.md`, errors, atomic cache, curl acceptance  
2. **Extension shell** — manifests/build per `.spec/extension.md`, options secret, popup health  
3. **Read path** — `.spec/reader.md` chunk/session + AudioBridge + blob play  
4. **Buffer + UX** — prefetch, selection, context menu, lang/voice, speeds  
5. **Polish** — keepalive, shortcuts gate, dark UI, README  
6. **Optional** — example user unit  

Handoff: implement **one build-order step per session**; do not freestyle architecture; note gaps in `DECISIONS.md`.

## v1 checklist

- [x] server.sh / run.sh start/stop, :24765, secret  
- [x] rpc.md curl suite green (health/voices/synth/audio/errors)  
- [x] no empty/partial finals; LRU  
- [x] extension shell: manifests/build, options secret, popup health  
- [x] extension blob play; highlight; buffer; selection; Read From Here  
- [x] lang filter; gen −50…+100/10%; free playbackRate  
- [ ] Chrome + FF smoke; refuse PDF/privileged  
- [ ] toasts only for current play chunk  

## Defaults

| Item | Value |
|------|--------|
| Port | 24765 |
| Python | 3.12.8 via DEPENDENCIES.sh |
| Workers | 2 |
| Buffer | 1 / 8 |
| Voice | en-US-EmmaMultilingualNeural |
| Lang | en (if available) |
| Gen speed | +0% |
| Playback speed | 1.0 |
| Pitch | +0Hz hidden |
| min_audio_bytes | 256 |
| Play retries | 3 (config) |
| Prefetch max attempts | 2 |
| Voice list fresh/stale | 24h |
| Voice refresh backoff | 5 min … 30 min |
| Skew/403 circuit | 3 strikes → 5 min open |
| Keepalive / FAB / shortcuts | off |
| Chunk fail | skip |

---

*Brief overrides: HTTP+blob not file/page media; extension playback; fixed port; hash includes rate+pitch; secret; LRU; CORS; daemon retry taxonomy; no 0KB cache files.*
