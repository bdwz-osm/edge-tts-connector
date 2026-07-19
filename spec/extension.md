# Extension build + runtime

Parent: [`../project.md`](../project.md). Wire: [`rpc.md`](rpc.md). Reader: [`reader.md`](reader.md).

## Layout

```
extension/
  package.json
  esbuild.config.mjs          # or scripts in package.json
  manifest.chrome.json        # MV3 service_worker + offscreen perm
  manifest.firefox.json       # MV3 event page scripts + gecko id
  src/
    background.ts
    offscreen.ts / offscreen.html
    audioBridge.ts            # thin; or logic split chrome/ff
    content.ts
    chunk.ts
    rpc.ts                    # daemon fetch helpers (bg only)
    popup.ts html css
    options.ts html css
    styles/highlight.css
  dist/                       # load unpacked from here
    manifest.json             # copied chrome or firefox at build
    *.js *.html *.css
```

## Build

```bash
cd extension && npm i
npm run build:chrome    # esbuild entries → dist/ + cp manifest.chrome.json dist/manifest.json
npm run build:firefox   # same + firefox manifest
```

**esbuild entries:** `background`, `content`, `popup`, `options`, `offscreen` (chrome). Bundle `webextension-polyfill` into bg/popup/options/content as needed.

Load unpacked: Chrome `chrome://extensions` → dist/; Firefox `about:debugging` → dist/.

No remote code. TS target ES2022. Keep deps minimal (polyfill + esbuild).

## Manifest essentials (both)

```json
{
  "manifest_version": 3,
  "name": "edge-tts-connector",
  "version": "0.1.0",
  "permissions": ["storage", "activeTab", "scripting", "contextMenus", "tabs"],
  "host_permissions": ["http://127.0.0.1:24765/*"],
  "action": { "default_popup": "popup.html", "default_title": "Edge TTS" },
  "options_ui": { "page": "options.html", "open_in_tab": true },
  "commands": {
    "toggle-pause": { "description": "Play/pause" },
    "next-chunk": { "description": "Next chunk" },
    "prev-chunk": { "description": "Previous chunk" }
  }
}
```

**Chrome add:** `"permissions": […, "offscreen"]`, `"background": { "service_worker": "background.js", "type": "module" }`.

**Firefox add:**
```json
"background": { "scripts": ["background.js"], "type": "module" },
"browser_specific_settings": {
  "gecko": { "id": "edge-tts-connector@local", "strict_min_version": "121.0" }
}
```

No default `content_scripts`. Inject on user activate:

```js
await browser.scripting.insertCSS({ target: { tabId }, files: ["styles/highlight.css"] })
await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] })
```

**Refuse activate** if URL matches: `chrome:`, `chrome-extension:`, `about:`, `edge:`, `devtools:`, Web Store, or obvious built-in PDF viewer schemes—show popup/page error.

Context menu (onInstalled): `Edge TTS: Read From Here` contexts `["page","selection"]`.

## Settings (`storage.local`)

| key | default |
|-----|---------|
| secret | `""` |
| lang | `"en"` |
| voice | `"en-US-EmmaMultilingualNeural"` |
| genSpeed | `"+0%"` |
| volume | `1` |
| playbackSpeed | `1` |
| showInPageToggle | `false` |
| shortcutsEnabled | `false` |
| bufferAhead | `8` |
| bufferBehind | `1` |
| audioKeepalive | `false` |

Pitch always `+0Hz` on wire v1 (not stored).

## AudioBridge

| | Chrome | Firefox |
|--|--------|---------|
| Where | `offscreen.html` + `offscreen.ts` | same bg page as SW substitute (`Audio` in event page) |
| Create | `offscreen.createDocument({ url, reasons:["AUDIO_PLAYBACK","BLOBS"], justification:"TTS playback" })` singleflight | N/A |
| Idle | doc may die ~30s after silence → recreate on next play | may suspend when idle → play wakes |
| Keepalive off | recreate on resume | cold resume |
| Keepalive on | while `paused`, single silent loop (`<audio loop>` tiny silent asset **or** WebAudio gain~0 oscillator); stop on play/stop/session end/setting off | optional no-op |

Never stack keepalives. `ended`/`error` → message background (SW may be asleep—offscreen must sendMessage).

## UI (dark)

- **Options:** secret paste, test connection, open shortcuts help link text.
- **Popup:** online/secret status; play/pause; ±chunk; lang; voice; gen speed select (−50…+100 /10); playback speed range 0.5–2.0 step 0.05; volume; keepalive checkbox; clear cache; link options.
- **Toasts:** content only for current play-chunk failures / refuse / empty (see reader).

## Sole RPC client

Background (and offscreen only for blob fetch if simpler—prefer **background fetches**, pass blobUrl to offscreen). Content never `fetch` daemon.
