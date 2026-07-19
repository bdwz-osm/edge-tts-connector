# RPC + messaging

Parent: [`../project.md`](../project.md). Base: `http://127.0.0.1:24765`. Auth header `X-Auth-Token: <secret>` on all but `/health`. CORS: echo only `chrome-extension://*` / `moz-extension://*` Origins; `OPTIONS` preflight; allow `X-Auth-Token, Content-Type`.

## HTTP routes

| Method | Path | Auth | |
|--------|------|------|--|
| GET | `/health` | no | liveness |
| GET | `/voices` | yes | Voice DTO[] |
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

curl -s "${H[@]}" -d '{"text":"Hello.","voice":"en-US-EmmaMultilingualNeural","rate":"+0%","pitch":"+0Hz"}' \
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
| 400 | `bad_request` | validation |
| 401 | `unauthorized` | bad/missing token |
| 404 | `not_found` | audio missing/too small |
| 503 | `upstream_offline` | no route to MS / DNS |
| 503 | `busy` | queue full |
| 502 | `upstream_transient` | retries exhausted |
| 502 | `upstream_reject` | permanent upstream |
| 500 | `internal` | disk/bug |
| 504 | `timeout` | optional if overall budget exceeded |

```json
{"status":"error","error":"upstream_offline","message":"…","attempts":1}
```

Synth request body: `{ "text": string, "voice"?: string, "rate"?: "+0%", "pitch"?: "+0Hz" }`. Defaults: config voice, `+0%`, `+0Hz`. Reject rate not in discrete −50…+100 step 10.

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
| `audio/stop` | bg→ | `{}` | pause, clear src, revoke |
| `audio/setGain` | bg→ | `{ volume?, playbackSpeed? }` | live |
| `audio/keepalive` | bg→ | `{ on: boolean }` | |
| `audio/ended` | →bg | `{}` | |
| `audio/error` | →bg | `{ message: string }` | |
| `audio/state` | →bg | `{ playing: boolean }` | optional |

**Play pipeline (background):**
1. `POST /v1/synth` with text/voice/rate/pitch  
2. `GET /audio/...` with token → `blob` → `URL.createObjectURL`  
3. `audio/play` with blobUrl  
4. On evict/stop: `revokeObjectURL`

Popup/options talk only to background (`popup/*` types as needed: getStatus, setSettings, transport commands)—keep thin; not normative beyond: popup never fetch(daemon) directly if SW can (prefer bg sole RPC client).
