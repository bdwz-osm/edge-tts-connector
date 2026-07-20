# Chunking + session

Parent: [`../project.md`](../project.md). Messages: [`rpc.md`](rpc.md). Site rules: [`extension.md`](extension.md).

## Chunk algorithm (deterministic)

```
SOFT_MAX = 500
HARD_MAX = daemon max_text_chars (2000)  # client must not exceed

BLOCK_SEL = p, h1-h6, li, blockquote, pre, figcaption, dt, dd
EXCLUDE  = nav, aside, footer, header, script, style, noscript, iframe, svg,
           [aria-hidden=true], [role=navigation|complementary|banner|contentinfo]
+ per-site destroy selectors (see site rules)
```

### Pipeline (page mode)

```
1. Match site rules → destroy selector list
2. Clone document; stamp parallel data-etc-nid; strip destroy on clone
3. Readability(clone):
     fail / empty → toast "Cleaned view failed; using basic extract"; root = pickRoot(live)
     ok → map stamps / article|main back to live root (highlight stays on live DOM)
4. lead-in: if title/author live outside root (hero above article), prepend
   chunks (else Readability title/byline, else cleaned document.title)
5. chunk under live root; visibleText + block walk skip EXCLUDE ∪ destroy
6. splitSoft each block text; dedupe lead vs body
```


```
function pickRoot(doc, destroy):
  for sel in [article, [role=main], main]:
    el = doc.querySelector(sel)
    // EXCLUDE + destroy on the candidate itself (not only descendants)
    if el and textLen(el) > 200 and not excluded/destroy(el): return el
  // Baseline score = body. Candidate must beat body (else flat pages pick
  // a .sourceCode/<pre> wrapper — high text, zero links — and skip the top).
  best = body; bestScore = textLen(body) - 2*linkTextLen(body)
  for el in body descendants div/section/main:
    skip EXCLUDE/destroy, code wrappers (.sourceCode/pre/code/highlight), tl < 200
    score = textLen(el) - 2*linkTextLen(el)
    if score > bestScore: best = el
  return best

function visibleText(el):
  // skip EXCLUDE, destroy selectors, display:none / visibility:hidden; collapse WS

function splitSoft(text):  // ladder
  if !text after collapse: return []
  if len <= SOFT_MAX: return [text]
  // 1) strong sentence: (?<=[.!?…])\s+ | CJK 。！？； | ;\s+
  // 2) weak clause if still over: :\s | —\s | –\s | ,\s
  // 3) whitespace wrap at SOFT_MAX (word-wrap)
  // 4) HARD_MAX: prefer whitespace near limit, else hard slice
  // greedy pack parts ≤ SOFT_MAX between rungs
```

```
function chunkPage(doc):
  root = readabilityRoot or pickRoot
  chunks = []
  i = 0
  for each leaf BLOCK_SEL under root:
    if excluded/destroy or not under root: continue
    text = visibleText(el)
    if not text: continue
    for part in splitSoft(text):
      chunks.push({ i, text: part, anchor: childIndexPath(root, el) })
      i++
  if empty and visibleText(root):
    fallback splitSoft(visibleText(root)) anchor []
```

`childIndexPath(root, el)`: indices among **element children only**. Highlight: walk path; fail → skip highlight that tick.

**Nested blocks:** only **leaf** `BLOCK_SEL` (skip el that contains another `BLOCK_SEL`).

### Entry modes (do not mix)

| Entry | mode | chunks | start |
|-------|------|--------|-------|
| Popup Play | `page` | full page pipeline | 0 (or resume if paused) |
| Context **Read from here** | `page` | full page pipeline | nearest chunk to contextmenu target |
| Context **Read selection** | `selection` | selection text only (destroy applied on cloneContents) | 0 |

Play **never** hijacks a DOM selection. Selection is menu-only.

**Read from here:** always page mode. Requires content script that recorded `contextmenu` target (manifest `content_scripts` on http(s)). Cold inject-only without prior ctx → index 0.

**Read selection:** `contexts: ["selection"]` only. Empty selection → error toast.

**UX timeouts:** play abandon **45s**; prefetch **30s**.

## Session state machine

One global session (background).

```
SessionStatus = idle | starting | playing | paused | offline | error

Session = {
  tabId, status, mode, chunks, index,
  buffer: Map<i, { id, blob, state: pending|ready|err }>,
  voice, rate, pitch
}
```

```
activate(tab, { mode, startIndex, chunks? }):
  if restrictedURL: refuse; return
  stop(previous) if any
  ensure content; status=starting
  health check → fail ⇒ offline
  chunks from content (page | selection) if not provided
  readabilityFailed && page → warn toast + continue
  empty → error toast
  index = startIndex; prefetch; play

ended: index++; play or stop
// … buffer / offline / 502 skip unchanged from prior spec
```

### Buffer window

`lo = max(0, index - bufferBehind)`  
`hi = min(len-1, index + bufferAhead)`  
defaults behind=1, ahead=8.

## Highlight

`content/highlight` → CSS class on anchored element; `scrollIntoView({block:"nearest"})`. Sub-chunks from one block share the block anchor (v1).
