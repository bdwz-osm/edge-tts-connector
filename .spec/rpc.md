# RPC + messaging

Parent: [`project.md`](project.md). Base: `http://127.0.0.1:24765`. Auth header `X-Auth-Token: <secret>` on all but `/health`. CORS: echo only `chrome-extension://*` / `moz-extension://*` Origins; `OPTIONS` preflight; allow `X-Auth-Token, Content-Type`.

Library exception inventory (not product law): [`edge-tts-errors.md`](edge-tts-errors.md). Product mapping below wins.

## HTTP routes

| Method | Path | Auth | |
|--------|------|------|--|
| GET | `/health` | no | liveness |
| GET | `/voices` | yes | voice list envelope (or `voices_unavailable`) |
| POST | `/v1/synth` | yes | synth or cache hit |
| GET | `/audio/{voice}/{id}.mp3` | yes | `audio/mpeg` |
| POST | `/v1/cache/clear` | yes | |
| GET | `/v1/cache/stats` | yes | `{bytes,files}` |

### Voice DTO

From `await edge_tts.list_voices()` (not CLI scrape):

```json
{
  "id": "en-US-EmmaMultilingualNeural",
  "locale": "en-US",
  "lang": "en",
  "gender": "Female",
  "friendlyName": "Microsoft Emma Multilingual Online (Natural) - English (United States)",
  "status": "GA"
}
```

Map: `id←ShortName`, `locale←Locale`, `lang←Locale.split("-")[0].lower()`, `gender←Gender`, `friendlyName←FriendlyName`, `status←Status`. Drop `Name`, `SuggestedCodec`, `VoiceTag`.

### GET `/voices` envelope

**200** — daemon has at least one voice in memory (from network and/or disk cache):

```json
{
  "voices": [ /* Voice DTO[] */ ],
  "source": "network",
  "fetched_at": "2026-07-18T12:00:00+00:00",
  "stale": false
}
```

| Field | Meaning |
|-------|---------|
| `source` | `network` if last successful fill was live `list_voices`; `cache` if serving disk fallback after failed refresh |
| `fetched_at` | ISO-8601 UTC timestamp of the data’s origin (when list was last successfully fetched from MS) |
| `stale` | `true` when `now - fetched_at > 24h` (extension may warn; still usable) |

**503** — no usable list (network failed and no disk cache / empty cache):

```json
{
  "status": "error",
  "error": "voices_unavailable",
  "message": "voice list unavailable",
  "voices": []
}
```

Extension: voice picker shows error; reading may still synth by ShortName when the fresh-cache voice gate is off (see synth validation).

### Cache id

```
id = md5_hex(utf8(f"rate:{rate}\0pitch:{pitch}\0{text}"))
path = tts-cache/<voice>/<id>.mp3
```

`voice` = ShortName path segment only. `rate` e.g. `+0%`; `pitch` e.g. `+0Hz`.

### curl examples

```bash
TOKEN=…  # from repo-root config.toml → auth.secret
H=(-H "X-Auth-Token: $TOKEN" -H "Content-Type: application/json")

curl -s "http://127.0.0.1:24765/health"
# {"ok":true,"version":"0.1.0"}

curl -s "${H[@]}" "http://127.0.0.1:24765/voices" | head

curl -s "${H[@]}" -d '{"text":"Hello.","voice":"en-US-EmmaMultilingualNeural","rate":"+0%","pitch":"+0Hz","priority":"play"}' \
  http://127.0.0.1:24765/v1/synth
# {"status":"ready","id":"<32hex>","voice":"en-US-EmmaMultilingualNeural","cached":false}

curl -s "${H[@]}" -o /tmp/t.mp3 \
  "http://127.0.0.1:24765/audio/en-US-EmmaMultilingualNeural/<id>.mp3"
```

### Response bodies

**Ready (200):**
```json
{"status":"ready","id":"…","voice":"…","cached":true}
```

**Errors** (always JSON, no stacks):

| HTTP | body.error | when |
|------|------------|------|
| 400 | `bad_request` | validation (incl. unknown voice when fresh voice list gate is on) |
| 401 | `unauthorized` | bad/missing token |
| 404 | `not_found` | audio missing/too small |
| 503 | `upstream_offline` | no route to MS / DNS / TLS unusable / MS HTTP 403 / skew / circuit open |
| 503 | `busy` | queue full |
| 503 | `voices_unavailable` | `GET /voices` only — no list in memory or disk |
| 502 | `upstream_transient` | retries exhausted on transient upstream |
| 502 | `upstream_reject` | permanent upstream / empty audio / protocol reject |
| 500 | `internal` | disk/bug |

```json
{"status":"error","error":"upstream_offline","message":"…","attempts":1}
```

**Synth request body:**

```json
{
  "text": "string",
  "voice": "en-US-EmmaMultilingualNeural",
  "rate": "+0%",
  "pitch": "+0Hz",
  "priority": "play"
}
```

| Field | Default | Notes |
|-------|---------|--------|
| `text` | required | non-empty; max `max_text_chars` |
| `voice` | config `default_voice` | ShortName |
| `rate` | `+0%` | discrete −50…+100 step 10 |
| `pitch` | `+0Hz` | wire form `±NHz` |
| `priority` | `play` | `play` \| `prefetch` — retry budget only (see below) |

### Exception → wire mapping (synth worker)

Classify with `isinstance` / aiohttp status — not message substrings. Guide: [`edge-tts-errors.md`](edge-tts-errors.md). Goal: screen-reader calm (no thrash, clear offline, skip bad chunks).

| Kind | Retry? | Sources (non-exhaustive) |
|------|--------|---------------------------|
| `bad_request` | no | Our validation; `TypeError`/`ValueError` from edge-tts on inputs we should have caught |
| `upstream_offline` | play: no; prefetch: within prefetch budget only | DNS / connect refused / unreachable; SSL/cert failures; `SkewAdjustmentError`; **HTTP 403** (post-library); circuit open |
| `upstream_transient` | yes (budget) | `WebSocketError`; connection reset/abort; aiohttp timeouts; `ClientConnectorError` (non-offline); HTTP 429/502/503; other 5xx |
| `upstream_reject` | no | `NoAudioReceived`; final audio `< min_audio_bytes`; `UnknownResponse`; `UnexpectedResponse`; HTTP 4xx **except 403 and 429**; unusable protocol/parse (`JSONDecodeError`, structural `KeyError`) |
| `internal` | no | Unexpected bugs; disk `OSError` on cache write (not ENOSPC-as-offline) |
| `busy` | no | Queue full before accept |

**HTTP 403 (single mapping):** Always `upstream_offline` + **clock/auth sickness** for the circuit breaker. Never `upstream_reject`. edge-tts may already have adjusted skew and retried once inside the same `Communicate` attempt; a 403 that still escapes is treated as unusable path to MS (clock/proxy/DRM), not a permanent content reject. One daemon attempt = one new `Communicate` — do not multiply daemon retries to “undo” the library’s inner 403 retry.

**Not used on daemon synth path:** `timeout` / 504. Do **not** wrap `Communicate.stream()` in daemon `wait_for`. edge-tts owns connect/read timeouts. Extension applies UX timeouts and may drop late HTTP responses; in-flight daemon work can finish and populate cache (harmless).

**`UnexpectedResponse` / protocol:** no retry (protocol mismatch will not heal).

### Retry budgets

| `priority` | Max attempts | Notes |
|------------|--------------|--------|
| `play` | `synth_retries` from config (default 3) | Only **transient** kinds advance the retry counter. offline/reject/bad_request/internal fail on that attempt (403/offline included: no play retry). |
| `prefetch` | **2** (fixed) | Same classification; never uses full play budget. Silent at extension. Prefetch may retry offline (incl. 403) once within this budget. |

Backoff between attempts: `synth_retry_backoff_s` (last entry reused if attempts exceed length).

In-flight **coalesce** by cache key still applies across priorities (one worker job; waiters share the result).

### Circuit breaker (process-wide)

Clock/auth sickness = `SkewAdjustmentError` **or** HTTP **403** (both already classified `upstream_offline`). After **3 consecutive** synth failures with that flag, **open** for **5 minutes**:

- New synth → immediate `upstream_offline` (no upstream call)
- Successful synth or successful live voice fetch → **close** and reset counter
- Purpose: stop stampedes when host clock/proxy breaks Sec-MS-GEC

### Voice list gate (synth)

| Voice list state | Unknown `voice` ShortName |
|------------------|---------------------------|
| Fresh list in memory (`fetched_at` within 24h, non-empty) | **400** `bad_request` |
| No list, or list older than 24h | Allow any `VOICE_RE`-valid ShortName (edge-tts may still `NoAudioReceived`) |

### Voices cache (daemon)

- Path: `daemon/voices-cache.json` (gitignore)
- On startup: try live `list_voices()`; on success write cache + memory; on failure load cache if present
- If still empty → `GET /voices` → 503 `voices_unavailable`; background refresh continues
- Background refresh while live fetch is failing: backoff **5 min → … → 30 min** per attempt (cap 30); on success reset backoff and overwrite cache
- Never block synth workers on voice refresh

## Extension internal messages

All `runtime` messages: `{ type: string, ... }`. Background validates `type`; ignore unknown. Content **never** gets secret or raw daemon URLs with token.

### content → background

| type | payload | |
|------|---------|--|
| `content/ready` | `{ tabId implicit }` | injected, DOM ready |
| `content/chunks` | `{ chunks: Chunk[], mode: "page"\|"selection" }` | after chunk |
| `content/readFromHere` | `{ chunkIndex: number }` | context menu path may go bg→content first |
| `content/fab` | `{ action: "toggle" }` | optional FAB |
| `content/gone` | `{}` | page unloading |

`Chunk = { i: number, text: string, anchor: number[] }` — `anchor` = child-index path from chosen root (see `reader.md`).

### background → content

| type | payload | |
|------|---------|--|
| `content/highlight` | `{ chunkIndex: number }` | |
| `content/clearHighlight` | `{}` | |
| `content/toast` | `{ level: "info"\|"warn"\|"error", message: string }` | **play-chunk only** |
| `content/status` | `{ status: SessionStatus }` | optional FAB sync |

### background ↔ AudioBridge (offscreen or FF bg)

| type | dir | payload | |
|------|-----|---------|--|
| `audio/ensure` | bg→ | `{}` | create offscreen if needed |
| `audio/play` | bg→ | `{ blobUrl, volume, playbackSpeed }` | |
| `audio/pause` | bg→ | `{}` | |
| `audio/resume` | bg→ | `{}` | |
| `audio/stop` | bg→ | `{}` | pause, clear src (bg revokes blob URLs) |
| `audio/setGain` | bg→ | `{ volume?, playbackSpeed? }` | live |
| `audio/keepalive` | bg→ | `{ on: boolean }` | |
| `audio/ended` | →bg | `{}` | |
| `audio/error` | →bg | `{ message: string }` | |
| `audio/state` | →bg | `{ playing: boolean }` | optional |

**Play pipeline (background):**
1. `POST /v1/synth` with text/voice/rate/pitch and `priority: "play"` (prefetch uses `"prefetch"`)
2. `GET /audio/...` with token → `Blob` (keep in session buffer; **do not** `createObjectURL` in Chrome SW — API missing)
3. `audio/play` with `{ blob, volume, playbackSpeed }` — Chrome offscreen / FF bg creates object URL and plays
4. On stop/next: bridge revokes its object URL; buffer drops `Blob` refs on evict

Parallel: extension may have multiple in-flight `/v1/synth` calls (play + prefetch). Daemon workers + coalesce handle concurrency. UX timeouts live in the extension (abort controller / ignore late); daemon does not kill edge-tts mid-stream for time.

Popup/options talk only to background (`popup/*` types as needed: getStatus, setSettings, transport commands)—keep thin; not normative beyond: popup never fetch(daemon) directly if SW can (prefer bg sole RPC client).
