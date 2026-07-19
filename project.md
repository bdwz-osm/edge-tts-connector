# edge-tts-connector

Local screen-reader-style TTS for Chromium + Firefox. Extension never hits the net for TTS. Loopback Python daemon runs `edge-tts` (→ Microsoft), caches MP3s, serves RPC + audio.

## Spec map

| Doc | Contents |
|-----|----------|
| **this file** | goals, architecture, daemon ops, defaults, build order |
| [`spec/rpc.md`](spec/rpc.md) | HTTP wire + curl examples + extension message types |
| [`spec/reader.md`](spec/reader.md) | chunk algorithm, session state machine, buffer/highlight |
| [`spec/extension.md`](spec/extension.md) | manifests, build, AudioBridge, settings/UI |

Implement against **all four**. If conflict: `project.md` wins on product intent; wire details win in `spec/*`.

## Goals / non-goals

**In:** dark popup; deterministic chunking; buffer-ahead; highlight; optional shortcuts; selection; context “Read From Here”; one active tab; discrete gen speed + free playback speed; client volume; lang-filtered voices; shared-secret loopback HTTP; LRU cache; smart daemon retries; `run.sh start|stop`; pinned Python via `DEPENDENCIES.sh`.

**Out:** cloud backend; `file://` / page `<audio>`; multi-tab sessions; full a11y SR; offline models; DRM bypass; PDF/chrome-privileged pages; word-level highlight (v2); systemd hard dependency; dumping TTS UX knobs into daemon config.

## Layout

```
project.md
spec/rpc.md  spec/reader.md  spec/extension.md
README.md
DEPENDENCIES.sh              # PYTHON_VERSION=… (manual bump)
server.sh                    # → daemon/run.sh start|stop
config.toml                  # runtime ops config (gitignore)
daemon/
  run.sh  requirements.txt
  server.py  tts.py  cache.py  config.py
  venv/  edge-tts-connector.pid
extension/                   # see spec/extension.md → dist/
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
- Audio: auth `fetch` → `blob:` URL (never secret in `src`). Details: `spec/rpc.md`.
- Port **24765** fixed both sides; host always `127.0.0.1` (not `localhost`).

### Knob ownership

| Knob | Owner |
|------|--------|
| secret, workers, cache cap, timeouts, retries, min_audio_bytes | daemon `config.toml` |
| port/host | hardcoded v1 |
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
# …

[cache]
# dir = "tts-cache"
# …
```

Reject non-loopback host; workers ∈ [1,3].

### Runtime rules

- Preload: `await edge_tts.list_voices()` → memory; soft-fail empty.
- Synth: `Communicate(..., rate=genSpeed, pitch=..., volume="+0%")`. Rate discrete **−50%…+100%** step 10%; pitch default `+0Hz`.
- **No poison cache:** write `*.part` only; unlink on fail; rename only if bytes ≥ `min_audio_bytes` and not `NoAudioReceived`; purge existing too-small finals; never `ready` without good final file.
- Errors/retries/HTTP: classify in `tts.py` — table + bodies in [`spec/rpc.md`](spec/rpc.md). Offline = no retry; transient = backoff retries; coalesce in-flight by id.
- Cache path: `tts-cache/<voice>/<md5(rate,pitch,text)>.mp3` — formula in `spec/rpc.md`. LRU by mtime to cap. Semaphore(workers).
- Routes/CORS/auth/Voice DTO: **`spec/rpc.md` only**.

## Extension (summary)

Full detail: [`spec/extension.md`](spec/extension.md), [`spec/reader.md`](spec/reader.md).

- MV3 Chrome + Firefox; inject on activate; refuse privileged/PDF URLs; main frame only.
- Lang list from voices present only; `Intl.DisplayNames`; voice = `ShortName` id.
- Gen speed stepped (resynth + hash); playback speed = `playbackRate` live; volume live.
- One session; buffer 1 behind / 8 ahead; skip on exhausted 502 for current chunk; prefetch silent.
- `audioKeepalive` default off; safe toggle.

## Failure UX

| Case | UI |
|------|-----|
| Daemon down | offline banner |
| 401 | bad secret |
| 503 upstream_offline | pause + banner (play chunk) |
| 502 exhausted | toast current; skip next |
| 503 busy | prefetch silent; play retry once |
| Restricted/PDF | refuse |
| Empty text | message |
| Nav/tab close | destroy session, revoke blobs |

## Threats

Local+secret abuse (accepted); `/health` open; CORS extension-origin only; no partial finals; never non-loopback; no secret/body text in logs.

## Build order

1. **Daemon** — DEPENDENCIES, run.sh, config/secret, routes per `spec/rpc.md`, errors, atomic cache, curl acceptance  
2. **Extension shell** — manifests/build per `spec/extension.md`, options secret, popup health  
3. **Read path** — `spec/reader.md` chunk/session + AudioBridge + blob play  
4. **Buffer + UX** — prefetch, selection, context menu, lang/voice, speeds  
5. **Polish** — keepalive, shortcuts gate, dark UI, README  
6. **Optional** — example user unit  

Handoff: implement **one build-order step per session**; do not freestyle architecture; note gaps in `DECISIONS.md`.

## v1 checklist

- [ ] server.sh / run.sh start/stop, :24765, secret  


- [ ] rpc.md curl suite green (health/voices/synth/audio/errors)  
- [ ] no empty/partial finals; LRU  
- [ ] extension blob play; highlight; buffer; selection; Read From Here  
- [ ] lang filter; gen −50…+100/10%; free playbackRate  
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
| Keepalive / FAB / shortcuts | off |
| Chunk fail | skip |

---

*Brief overrides: HTTP+blob not file/page media; extension playback; fixed port; hash includes rate+pitch; secret; LRU; CORS; daemon retry taxonomy; no 0KB cache files.*
