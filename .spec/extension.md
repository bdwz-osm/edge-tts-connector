# Extension build + runtime

Parent: [`project.md`](project.md). Wire: [`rpc.md`](rpc.md). Reader: [`reader.md`](reader.md).

## Layout

```
extension/
  package.json
  esbuild.config.mjs
  manifest.chrome.json / manifest.firefox.json
  src/
    background.ts
    offscreen.ts / offscreen.html   # Chrome
    audioBridge.ts
    content.ts                      # always-on http(s) + on-demand inject
    chunk.ts  splitText.ts
    siteRules.ts
    rpc.ts
    popup / options / rules  (.ts .html .css)
    styles/highlight.css
```

Outputs: `build/chrome/`, `build/firefox/`.

## Build

```bash
./rebuild_extensions.sh
cd extension && npm run build && npm test
```

**esbuild entries:** `background`, `content` (IIFE), `popup`, `options`, `rules`, `offscreen` (chrome). Deps: `webextension-polyfill`, `@mozilla/readability`.

## Manifest

```json
{
  "manifest_version": 3,
  "name": "etc Speech",
  "permissions": ["storage", "activeTab", "scripting", "contextMenus", "tabs"],
  "host_permissions": ["http://127.0.0.1:24765/*"],
  "content_scripts": [{
    "matches": ["http://*/*", "https://*/*"],
    "js": ["content.js"],
    "css": ["styles/highlight.css"],
    "run_at": "document_idle",
    "all_frames": false
  }],
  "action": { "default_popup": "popup.html" },
  "options_ui": { "page": "options.html", "open_in_tab": true }
}
```

**Chrome:** + `offscreen`; SW background; port in host_permissions.  
**Firefox:** host `http://127.0.0.1/*` (no port in patterns); event page scripts; gecko id.

Always-on content script records `contextmenu` target (RFH) and answers chunk messages. `injectContent` still used as fallback (ping / executeScript).

**Refuse activate** on privileged/PDF URLs (`urls.ts`).

### Context menus

| id | title | contexts |
|----|-------|----------|
| `edge-tts-read-from-here` | etc Speech: Read from here | `page` only |
| `edge-tts-read-selection` | etc Speech: Read selection | `selection` only |

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
| **siteRules** | seeded store (see below) |
| **siteRuleDraft** | editor draft (ephemeral) |

Pitch `+0Hz` on wire v1 (not stored).

### Live gain

- Drag: `popup/liveGain` → in-memory cache + `audioSetGain` (no storage write per tick).
- Release: `popup/setSettings` persists.
- `audioPlay` uses gain cache so chunk boundaries keep knob values.

## Site rules

**Store** (`siteRules`):

```ts
{
  version: 1,
  seedVersion: number,  // bump to inject new defaults once
  rules: SiteRule[]
}

SiteRule = {
  id, hosts: string[], pathPrefix: string,
  selectors: string[], enabled: boolean,
  note?, seedId?
}
```

**Host match:** exact hostname, or `*.example.com` → apex + any subdomain.  
**New rule from tab:** exact host + www/non-www twin.  
**Path:** empty = all paths; else pathname prefix.  
**Most specific:** longest matching `pathPrefix` among host hits; selectors **union** across all matches.

**Apply:** strip matching nodes on Readability **clone**; skip in live `visibleText` / block walk (do not mutate the real page).

**Default seed (seedVersion 1):** Wikipedia footnotes / edit sections — `*.wikipedia.org`, selectors `sup.reference`, `sup[id^='cite_ref']`, `.mw-editsection`, `span.mw-cite-backlink`.

**Import modes:** `replace_all` | `merge_union` | `merge_replace_key` (key = sorted hosts + pathPrefix).

**UI:** Options list + Import/Export; focused `rules.html` editor (draft autosave); popup “Site rules for this tab…”.

## AudioBridge

| | Chrome | Firefox |
|--|--------|---------|
| Where | offscreen doc | background `Audio` |
| ended/error | sendMessage → SW | **direct handlers** (sendMessage does not re-enter same frame) |

**Keepalive** (`audioKeepalive` setting, default off): while session is **paused**, play a single silent looped `<audio>` (tiny data-URI WAV) so the browser is less likely to suspend the offscreen doc / Firefox background audio. Stop keepalive on play, stop, session end, or setting off. Never stack multiple keepalive elements.

## UI (dark)

- **Options:** secret, probe, audio keepalive (+ short explanation), site rules list, shortcuts help.
- **Rules editor:** hosts, path prefix, selectors, note, enable; draft-safe.
- **Popup:** transport, lang/voice/speeds/volume, site rules, options.
- **Toasts:** readability fallback; play-chunk failures; empty selection/page.

## Sole RPC client

Background only for daemon HTTP. Content never `fetch` daemon.
