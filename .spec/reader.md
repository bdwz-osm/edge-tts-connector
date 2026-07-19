# Chunking + session

Parent: [`../project.md`](../project.md). Messages: [`rpc.md`](rpc.md).

## Chunk algorithm (deterministic)

```
SOFT_MAX = 500
HARD_MAX = daemon max_text_chars (2000)  # client must not exceed

BLOCK_SEL = p, h1-h6, li, blockquote, pre, figcaption, dt, dd
EXCLUDE  = nav, aside, footer, header, script, style, noscript, iframe, svg,
           [aria-hidden=true], [role=navigation|complementary|banner|contentinfo]

function pickRoot(doc):
  for sel in [article, [role=main], main]:
    if el = doc.querySelector(sel) and textLen(el) > 200: return el
  return argmax over doc.body descendants div/section/main:
    score = textLen(el) - 2*linkTextLen(el)
    skip if el matches EXCLUDE or inside EXCLUDE

function visibleText(el):
  // innerText-like: skip display:none / visibility:hidden; collapse whitespace

function splitSoft(text):
  if len(text) <= SOFT_MAX: return [text]
  // split on /(?<=[.!?…])\s+/ or CJK /(?<=[。！？；;])/
  // greedy pack parts <= SOFT_MAX; if one sentence > SOFT_MAX, hard-slice at HARD_MAX

function chunkPage(doc):
  root = pickRoot(doc)
  chunks = []
  i = 0
  for each el in root.querySelectorAll(BLOCK_SEL) in tree order:
    if el closest EXCLUDE or not under root: continue
    t = visibleText(el)
    if !t: continue
    for part in splitSoft(t):
      chunks.push({ i, text: part, anchor: childIndexPath(root, el) })
      i++
  return chunks

function chunkSelection(sel):
  t = sel.toString() collapsed WS
  // same splitSoft; anchor = path to commonAncestorContainer element or []
```

`childIndexPath(root, el)`: array of indices among **element children only** (skip text/comment nodes) from root to el. Highlight: walk path; if fails, skip highlight that tick.

**Empty BLOCK_SEL:** if no block chunks, fallback `splitSoft(visibleText(root))` with `anchor: []` (highlight may no-op). `visibleText` skips **EXCLUDE** and hidden nodes (same as block path). Nested blocks: only **leaf** `BLOCK_SEL` nodes (skip el that contains another `BLOCK_SEL` match) to avoid duplicate text.

**Selection mode:** non-empty selection on activate → `chunkSelection` only (`mode:"selection"`). Anchor from `sel.getRangeAt(0).commonAncestorContainer` (not `Selection` itself).

**Read From Here:** resolve target element → find chunk with same anchor or nearest ancestor with a chunk → set `index`, flush buffer, play. If all anchors are `[]` (fallback mode), map by visible-text offset within root. Cold start without prior inject: selection if any, else page (RFH index after inject).

Drop empty. No live MutationObserver v1.

**UX timeouts (extension):** play path abandon **45s**; prefetch **30s**.

## Session state machine

One global session (background).

```
SessionStatus = idle | starting | playing | paused | offline | error

Session = {
  tabId, status, mode, chunks, index,
  buffer: Map<i, { id, blobUrl, state: pending|ready|err }>,
  voice, rate, pitch
}
```

```
activate(tab):
  if restrictedURL: toast refuse; return
  stop(previous) if any
  inject content+css
  status=starting
  health check → fail ⇒ status=offline, banner
  content chunks → if empty: error "No readable text"
  index = 0 (or readFromHere index)
  prefetch window; play index

play/resume:
  status=playing; cancel keepalive; ensure audio; play buffer[index] (await synth if needed)

pause:
  status=paused; audio/pause; maybe keepalive

stop / tabRemoved / mainFrame nav(tabId):
  audio/stop; revoke all blobUrls; content/clearHighlight; session=null; status=idle

ended:
  index++
  if index >= len: stop (done)
  else highlight; play index; top up prefetch

genSpeed|voice|pitch change:
  revoke buffer; clear map; resynth from index; keep status

playbackSpeed|volume change:
  audio/setGain only

upstream_offline on play chunk:
  status=offline; pause; banner

502 on play chunk:
  toast; index++; play (skip)

502/503 on prefetch only:
  mark err quietly; retry later; no toast
```

### Buffer window

`lo = max(0, index - bufferBehind)`  
`hi = min(len-1, index + bufferAhead)`  
defaults behind=1, ahead=8.

For i in lo..hi missing/err: enqueue synth (cap parallel ≈ daemon workers).  
Outside window: revoke blobUrl, delete entry.

Priority: `index` first, then +1,+2,… then behind.

## Highlight

`content/highlight` → add CSS class on anchored element; `scrollIntoView({block:"nearest", inline:"nearest"})`. High-contrast outline (works on light/dark pages).
