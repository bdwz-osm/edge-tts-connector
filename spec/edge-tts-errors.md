# edge-tts Exception Reference

> **Purpose:** Machine- and human-readable inventory of every exception that can surface when using the `edge-tts` Python library (`edge_tts` package). Intended for daemons and orchestration code that run many concurrent TTS jobs and must classify failures.
>
> **Package version documented:** 7.2.8 (source tree at documentation time)
>
> **Primary API surface:** `edge_tts.Communicate`, `edge_tts.list_voices`, `edge_tts.VoicesManager`, `edge_tts.SubMaker`

---

## 1. Hierarchy (custom exceptions)

All custom exceptions live in `edge_tts.exceptions` and inherit from `Exception`.

```
Exception
└── edge_tts.exceptions.EdgeTTSException          # base for all edge-tts-specific errors
    ├── edge_tts.exceptions.UnknownResponse
    ├── edge_tts.exceptions.UnexpectedResponse
    ├── edge_tts.exceptions.NoAudioReceived
    ├── edge_tts.exceptions.WebSocketError
    └── edge_tts.exceptions.SkewAdjustmentError
```

**Import patterns:**

```python
from edge_tts.exceptions import (
    EdgeTTSException,
    UnknownResponse,
    UnexpectedResponse,
    NoAudioReceived,
    WebSocketError,
    SkewAdjustmentError,
)
# or
from edge_tts import exceptions
# exceptions.NoAudioReceived, etc.
```

Catch-all for any edge-tts-defined failure:

```python
except edge_tts.exceptions.EdgeTTSException as e:
    ...
```

---

## 2. Custom exceptions (full paths)

### 2.1 `edge_tts.exceptions.EdgeTTSException`

| Field | Value |
| --- | --- |
| **Full path** | `edge_tts.exceptions.EdgeTTSException` |
| **Base** | `Exception` |
| **Category** | Base / catch-all |
| **Raised directly?** | No — base class only |
| **Description** | Root of all package-specific errors. Prefer catching this (or a subclass) when the daemon only needs to know “edge-tts failed for a service/protocol reason” vs validation or I/O. |

---

### 2.2 `edge_tts.exceptions.UnknownResponse`

| Field | Value |
| --- | --- |
| **Full path** | `edge_tts.exceptions.UnknownResponse` |
| **Base** | `edge_tts.exceptions.EdgeTTSException` |
| **Category** | Protocol / server response (unknown shape) |
| **Where raised** | `edge_tts.communicate.Communicate` (stream path) |
| **Description** | Server sent a WebSocket message path or metadata type the client does not recognize. Usually indicates a service protocol change or unexpected Edge TTS backend behavior. |

**Concrete raise sites and messages:**

| Location | Message pattern | When |
| --- | --- | --- |
| `communicate.Communicate.__parse_metadata` | `"Unknown metadata type: {meta_type}"` | Metadata JSON contains a `Type` other than `WordBoundary`, `SentenceBoundary`, or `SessionEnd` |
| `communicate.Communicate.__stream` | `"Unknown path received"` | Text WebSocket frame `Path` is not one of `audio.metadata`, `turn.end`, `response`, `turn.start` |

**Daemon guidance:** Treat as non-retryable without investigation (protocol mismatch). Log full message; may need library upgrade if Microsoft changes the API.

---

### 2.3 `edge_tts.exceptions.UnexpectedResponse`

| Field | Value |
| --- | --- |
| **Full path** | `edge_tts.exceptions.UnexpectedResponse` |
| **Base** | `edge_tts.exceptions.EdgeTTSException` |
| **Category** | Protocol / server response (malformed or inconsistent) |
| **Where raised** | `edge_tts.communicate.Communicate` (stream path) |
| **Description** | Response structure is recognized enough to parse but violates expected invariants (missing audio, wrong content type, incomplete binary frames, empty metadata). Docs note this may appear if the server changes response format. |

**Concrete raise sites and messages:**

| Location | Message | When |
| --- | --- | --- |
| `Communicate.__parse_metadata` | `"No WordBoundary metadata found"` | Metadata array had no `WordBoundary`/`SentenceBoundary` entries (only e.g. `SessionEnd` or empty) |
| `Communicate.__stream` | `"We received a binary message, but it is missing the header length."` | Binary WS frame shorter than 2 bytes |
| `Communicate.__stream` | `"The header length is greater than the length of the data."` | Declared header length exceeds frame size |
| `Communicate.__stream` | `"Received binary message, but the path is not audio."` | Binary frame path ≠ `audio` |
| `Communicate.__stream` | `"Received binary message, but with an unexpected Content-Type."` | Content-Type not `audio/mpeg` and not absent |
| `Communicate.__stream` | `"Received binary message with no Content-Type, but with data."` | Empty Content-Type but payload non-empty |
| `Communicate.__stream` | `"Received binary message, but it is missing the audio data."` | Content-Type is audio but payload empty |

**Daemon guidance:** Generally non-retryable as-is. Transient network corruption is possible but rare; prefer fail-fast and alert. Do not confuse with `NoAudioReceived` (stream completed with zero audio chunks).

---

### 2.4 `edge_tts.exceptions.NoAudioReceived`

| Field | Value |
| --- | --- |
| **Full path** | `edge_tts.exceptions.NoAudioReceived` |
| **Base** | `edge_tts.exceptions.EdgeTTSException` |
| **Category** | TTS outcome / empty result |
| **Where raised** | `edge_tts.communicate.Communicate.__stream` (end of WebSocket session for a text chunk) |
| **Message** | `"No audio was received. Please verify that your parameters are correct."` |
| **Description** | WebSocket session finished (or loop ended) without yielding any audio binary chunks. Common causes: invalid/unsupported voice name that still connects, empty/unsuitable text after sanitization, or service accepting SSML but producing no audio. |

**Daemon guidance:** Often a **client parameter problem** (voice, text, prosody). Validate voice against `list_voices()` / `VoicesManager` before retry. Retrying the same payload usually fails again.

---

### 2.5 `edge_tts.exceptions.WebSocketError`

| Field | Value |
| --- | --- |
| **Full path** | `edge_tts.exceptions.WebSocketError` |
| **Base** | `edge_tts.exceptions.EdgeTTSException` |
| **Category** | Transport / WebSocket |
| **Where raised** | `edge_tts.communicate.Communicate.__stream` |
| **Message** | `received.data` if present, else `"Unknown error"` |
| **Description** | WebSocket message type was `aiohttp.WSMsgType.ERROR`. Wraps the underlying WS error payload from aiohttp. |

**Daemon guidance:** Often **transient** (network blip, proxy, remote close). Safe candidate for limited retries with backoff. Inspect `str(e)` for root cause detail.

---

### 2.6 `edge_tts.exceptions.SkewAdjustmentError`

| Field | Value |
| --- | --- |
| **Full path** | `edge_tts.exceptions.SkewAdjustmentError` |
| **Base** | `edge_tts.exceptions.EdgeTTSException` |
| **Category** | Auth / clock skew (Sec-MS-GEC DRM) |
| **Where raised** | `edge_tts.drm.DRM.handle_client_response_error` |
| **Description** | After HTTP **403**, the client tries to correct clock skew using the response `Date` header. This is raised when that header is missing or unparseable, so skew cannot be adjusted. Chained from the original `aiohttp.ClientResponseError` via `raise ... from e`. |

**Concrete messages:**

| Message | When |
| --- | --- |
| `"No server date in headers."` | `e.headers` is `None`, or no `Date` header, or `Date` is not a `str` |
| `"Failed to parse server date: {server_date}"` | `Date` present but not parseable as RFC 2616 (`%a, %d %b %Y %H:%M:%S %Z`) |

**Call paths that trigger skew handling (then possibly this error):**

1. `Communicate.stream` → `aiohttp.ClientResponseError` with `status == 403` → `DRM.handle_client_response_error` → retry stream once
2. `list_voices` → same 403 → skew adjust → retry list once

**Daemon guidance:** Indicates **system clock / proxy stripping Date / non-Edge 403**. Fix host time NTP; if behind a proxy that strips `Date`, configure it to pass the header. Not a pure “retry same request” fix unless clock is fixed. Note: `DRM.clock_skew_seconds` is a **class-level** shared float — concurrent 403 handling can race when many workers adjust skew in parallel.

---

## 3. Built-in Python exceptions raised by edge-tts

These are not subclasses of `EdgeTTSException`. They are raised directly by package code for validation or misuse.

### 3.1 Category: Input validation (`TypeError`)

| Full path | Message | Location | When |
| --- | --- | --- | --- |
| `builtins.TypeError` | `"text must be str"` | `Communicate.__init__` | `text` is not `str` |
| `builtins.TypeError` | `"proxy must be str"` | `Communicate.__init__` | `proxy` is not `None` and not `str` |
| `builtins.TypeError` | `"connect_timeout must be int"` | `Communicate.__init__` | `connect_timeout` is not `int` (note: `None` also fails) |
| `builtins.TypeError` | `"receive_timeout must be int"` | `Communicate.__init__` | `receive_timeout` is not `int` |
| `builtins.TypeError` | `"connector must be aiohttp.BaseConnector"` | `Communicate.__init__` | `connector` is not `None` and not a `BaseConnector` |
| `builtins.TypeError` | `"voice must be str"` | `TTSConfig.__post_init__` | `voice` is not `str` |
| `builtins.TypeError` | `"{param_name} must be str"` | `TTSConfig.validate_string_param` | `rate` / `volume` / `pitch` / validated `voice` not `str` |
| `builtins.TypeError` | `"data must be bytes"` | `get_headers_and_data` | Internal; non-bytes data |
| `builtins.TypeError` | `"string must be str or bytes"` | `remove_incompatible_characters` | Internal sanitizer |
| `builtins.TypeError` | `"text must be str or bytes"` | `split_text_by_byte_length` | Internal text splitter |

**Daemon guidance:** Programmer/API misuse. **Do not retry.** Fix caller inputs.

---

### 3.2 Category: Input validation (`ValueError`)

| Full path | Message | Location | When |
| --- | --- | --- | --- |
| `builtins.ValueError` | `"Invalid {param_name} '{param_value}'."` | `TTSConfig.validate_string_param` | `rate`, `volume`, `pitch`, or normalized `voice` fails regex |
| `builtins.ValueError` | `"byte_length must be greater than 0"` | `split_text_by_byte_length` | Internal; invalid split size |
| `builtins.ValueError` | `"Maximum byte length is too small or invalid text structure near '&' or invalid UTF-8"` | `split_text_by_byte_length` | Cannot find a safe split (pathological text / tiny limit) |
| `builtins.ValueError` | `"Invalid message type, expected 'WordBoundary' or 'SentenceBoundary'."` | `SubMaker.feed` | Fed an audio (or other) chunk |
| `builtins.ValueError` | `"Expected message type '{self.type}', but got '{msg['type']}'."` | `SubMaker.feed` | Mixed WordBoundary and SentenceBoundary in one SubMaker |

**Valid prosody / voice patterns (for daemon pre-validation):**

| Param | Regex (after voice normalization) |
| --- | --- |
| `voice` (final form) | `^Microsoft Server Speech Text to Speech Voice \(.+,.+\)$` |
| `rate` | `^[+-]\d+%$` e.g. `+0%`, `-50%` |
| `volume` | `^[+-]\d+%$` |
| `pitch` | `^[+-]\d+Hz$` e.g. `+0Hz` |

Short voice names like `en-US-JennyNeural` are accepted and rewritten to the long Microsoft form before the final voice regex.

**Daemon guidance:** Validation errors are **non-retryable**. Normalize/validate params before constructing `Communicate`.

---

### 3.3 Category: Lifecycle / API misuse (`RuntimeError`)

| Full path | Message | Location | When |
| --- | --- | --- | --- |
| `builtins.RuntimeError` | `"stream can only be called once."` | `Communicate.stream` | Second call to `stream()` / `stream_sync()` / `save` after stream already started |
| `builtins.RuntimeError` | `"VoicesManager.find() called before VoicesManager.create()"` | `VoicesManager.find` | Used `VoicesManager()` without `await VoicesManager.create()` |

**Daemon guidance:** For parallel jobs, **create one `Communicate` instance per TTS task** (or per stream attempt). Never share a single `Communicate` across concurrent streams. `stream_was_called` is instance state.

---

### 3.4 Category: Platform (`NotImplementedError`) — edge-playback only

| Full path | Message | Location | When |
| --- | --- | --- | --- |
| `builtins.NotImplementedError` | `"Function only available on Windows"` | `edge_playback.win32_playback` | Win32 MCI playback on non-Windows |

Relevant only if using `edge-playback`, not pure `edge_tts` synthesis.

---

## 4. Propagated third-party exceptions (not defined by edge-tts)

These are **not** raised with `raise` in package code as edge-tts types, but they **escape** to the caller from network I/O. A production daemon **must** handle them.

### 4.1 Category: HTTP / WebSocket client (`aiohttp`)

| Full path | Typical source | Behavior in edge-tts | Daemon notes |
| --- | --- | --- | --- |
| `aiohttp.ClientResponseError` | WS connect handshake or `list_voices` GET with `raise_for_status=True` | If `status == 403`, edge-tts attempts skew fix and **retries once**. Other statuses are **re-raised**. After successful skew adjust, retry may still raise. | **403** after skew path may become `SkewAdjustmentError` or a second 403/`ClientResponseError`. Other 4xx/5xx: classify by `e.status`. |
| `aiohttp.ClientConnectorError` | DNS, TCP, TLS connect failure | Propagates from `session.ws_connect` / `session.get` | Transient; retry with backoff |
| `aiohttp.ClientConnectorDNSError` | DNS failure (aiohttp subclass) | Propagates | Transient / infra |
| `aiohttp.ClientSSLError` / `aiohttp.ClientConnectorCertificateError` | TLS/cert issues | Propagates | Often config (certs, MITM proxy) |
| `aiohttp.WSServerHandshakeError` | WS upgrade failed | Propagates (subclass of ClientResponseError in many versions) | Check status; may be 403 → skew path depends on raise site |
| `aiohttp.ServerTimeoutError` | Socket read/connect timeout | From `ClientTimeout(sock_connect=connect_timeout, sock_read=receive_timeout)` | Defaults: connect 10s, read 60s. Transient |
| `aiohttp.ClientPayloadError` | Incomplete/corrupt payload | Possible on voice list body | Transient or proxy |
| `aiohttp.ClientError` | Base for most aiohttp client errors | Catch-all for aiohttp client layer | Broad network failure bucket |
| `aiohttp.ClientConnectionError` | Connection lost mid-request | Propagates | Transient |

**Timeouts (configurable on `Communicate` only):**

- `connect_timeout` → `sock_connect` (default `10`)
- `receive_timeout` → `sock_read` (default `60`)
- `list_voices` uses default `ClientSession` timeouts (aiohttp defaults), not the Communicate timeouts.

### 4.2 Category: Async / concurrency

| Full path | When |
| --- | --- |
| `asyncio.TimeoutError` | May surface depending on aiohttp/Python version for timeouts |
| `concurrent.futures.CancelledError` / thread exceptions | Via `stream_sync` / `save_sync` thread pool; underlying exception is usually re-raised by `future.result()` |

`stream_sync` / `save_sync` run async work in a worker thread; exceptions from `stream`/`save` propagate to the calling thread.

### 4.3 Category: Parsing (unhandled; can bubble)

These are not wrapped by edge-tts but can occur if the service returns unexpected payloads:

| Full path | Location | When |
| --- | --- | --- |
| `json.JSONDecodeError` | `Communicate.__parse_metadata`, `voices.__list_voices` | Non-JSON metadata or voice list body |
| `builtins.KeyError` | `Communicate.__parse_metadata` | Missing `Metadata` / `Data` / nested keys |
| `builtins.ValueError` | `get_headers_and_data` (`line.split(b":", 1)`) | Header line without `:` |
| `builtins.UnicodeDecodeError` | Unlikely on main paths; caught inside UTF-8 safe split | — |

**Daemon guidance:** Treat unexpected parse errors like protocol failures (`UnknownResponse` / `UnexpectedResponse`): log, fail job, alert on spikes.

### 4.4 Category: OS / I/O (save paths)

| Full path | Location | When |
| --- | --- | --- |
| `builtins.OSError` / `builtins.FileNotFoundError` / `builtins.PermissionError` | `Communicate.save` / `save_sync`, CLI util | Cannot open audio/metadata path |
| `builtins.IsADirectoryError` etc. | Same | Bad path |

---

## 5. Internal-only exceptions (do not handle in app code)

| Full path | Notes |
| --- | --- |
| `edge_tts.srt_composer._ShouldSkipException` | Private; raised and caught inside SRT composition to skip empty/invalid cues. **Never propagates** to `SubMaker.get_srt()` callers under normal use. |
| `builtins.UnicodeDecodeError` | Caught inside `_find_safe_utf8_split_point`; not re-raised. |
| `builtins.ValueError` in `DRM.parse_rfc2616_date` | Caught; returns `None` then may become `SkewAdjustmentError`. |
| `builtins.KeyboardInterrupt` | Caught only in CLI util interactive prompt; not library API. |

---

## 6. Categorized summary for daemon error handling

### A. Package-specific protocol / service (`EdgeTTSException` subclasses)

| Full path | Retry? | Typical meaning |
| --- | --- | --- |
| `edge_tts.exceptions.UnknownResponse` | No (investigate) | Unknown WS path or metadata type |
| `edge_tts.exceptions.UnexpectedResponse` | Rarely | Malformed binary/metadata audio frame |
| `edge_tts.exceptions.NoAudioReceived` | No (fix params) | Stream ended with zero audio |
| `edge_tts.exceptions.WebSocketError` | Yes (limited) | WS error frame |
| `edge_tts.exceptions.SkewAdjustmentError` | No until clock/proxy fixed | Cannot fix Sec-MS-GEC after 403 |

Catch-all: `edge_tts.exceptions.EdgeTTSException`

### B. Client validation / misuse (built-ins from edge-tts)

| Full path | Retry? | Typical meaning |
| --- | --- | --- |
| `builtins.TypeError` | No | Wrong argument types to `Communicate` / TTSConfig |
| `builtins.ValueError` | No | Bad rate/volume/pitch/voice; SubMaker misuse; split failure |
| `builtins.RuntimeError` | No | Double `stream()`; `VoicesManager.find` before `create` |

### C. Network / HTTP / TLS (aiohttp, etc.)

| Full path | Retry? | Typical meaning |
| --- | --- | --- |
| `aiohttp.ClientResponseError` | Depends on `status` | HTTP error; 403 special-cased for skew |
| `aiohttp.ClientConnectorError` | Yes | Connect/DNS/TCP failure |
| `aiohttp.ServerTimeoutError` | Yes | Connect/read timeout |
| `aiohttp.ClientError` | Often | Broad network bucket |
| SSL-related aiohttp errors | Rarely | Cert/proxy MITM issues |

### D. Parse / structural fallout

| Full path | Retry? | Typical meaning |
| --- | --- | --- |
| `json.JSONDecodeError` | No / rare yes | Bad JSON from service |
| `builtins.KeyError` | No | Unexpected metadata shape |

### E. File I/O (if using `save`)

| Full path | Retry? | Typical meaning |
| --- | --- | --- |
| `OSError` and subclasses | Depends | Disk path/permission problems |

---

## 7. Recommended daemon classification pattern

```python
from edge_tts.exceptions import (
    EdgeTTSException,
    NoAudioReceived,
    SkewAdjustmentError,
    UnexpectedResponse,
    UnknownResponse,
    WebSocketError,
)
import aiohttp

def classify_edge_tts_error(exc: BaseException) -> str:
    """Return a stable error class string for metrics / routing."""
    if isinstance(exc, NoAudioReceived):
        return "tts.empty_audio"          # fix voice/text; don't thrash retries
    if isinstance(exc, WebSocketError):
        return "tts.ws_error"             # retry with backoff
    if isinstance(exc, (UnknownResponse, UnexpectedResponse)):
        return "tts.protocol"             # alert; possible upstream/API change
    if isinstance(exc, SkewAdjustmentError):
        return "tts.clock_skew"           # fix host time / proxy Date header
    if isinstance(exc, EdgeTTSException):
        return "tts.edge_tts"             # other package-specific
    if isinstance(exc, aiohttp.ClientResponseError):
        return f"tts.http.{exc.status}"   # 403 may already have been retried once
    if isinstance(exc, aiohttp.ServerTimeoutError):
        return "tts.timeout"
    if isinstance(exc, aiohttp.ClientConnectorError):
        return "tts.connect"
    if isinstance(exc, aiohttp.ClientError):
        return "tts.network"
    if isinstance(exc, (TypeError, ValueError, RuntimeError)):
        return "tts.client_bug"           # validation / lifecycle misuse
    if isinstance(exc, OSError):
        return "tts.io"
    return "tts.unknown"
```

---

## 8. Parallel / multi-worker caveats (daemon-specific)

1. **One `Communicate` per job (and per attempt).** `stream()` may only be called once per instance (`RuntimeError` otherwise).
2. **Shared clock skew state.** `DRM.clock_skew_seconds` is class-level. Concurrent 403 responses can interleave adjustments. Usually converges, but be aware under mass 403s.
3. **403 handling retries once inside the library** (stream and list_voices). Daemon-level retries on top of that can multiply load; prefer backoff and circuit-breaking on repeated 403/`SkewAdjustmentError`.
4. **Connector reuse.** Optional `aiohttp.BaseConnector` can be shared across jobs for connection pooling; do not close it while tasks still run. Wrong type → `TypeError`.
5. **Timeouts are per-`Communicate` instance** for TTS; `list_voices` does not take the same timeout knobs.
6. **`NoAudioReceived` is per text chunk** inside multi-chunk long text: long input is split (~4096-byte SSML chunks); failure on one chunk aborts the stream generator.
7. **Exceptions from sync wrappers** (`stream_sync`, `save_sync`) are the same types as async; they surface on the calling thread via the executor.

---

## 9. Exhaustive checklist of raise identifiers

### Defined and raised by edge-tts (custom)

- `edge_tts.exceptions.UnknownResponse`
- `edge_tts.exceptions.UnexpectedResponse`
- `edge_tts.exceptions.NoAudioReceived`
- `edge_tts.exceptions.WebSocketError`
- `edge_tts.exceptions.SkewAdjustmentError`

### Defined by edge-tts but not raised directly

- `edge_tts.exceptions.EdgeTTSException` (base only)

### Built-ins raised by edge-tts library code

- `builtins.TypeError`
- `builtins.ValueError`
- `builtins.RuntimeError`
- `builtins.NotImplementedError` (`edge_playback` only)

### Commonly propagated (not edge-tts types)

- `aiohttp.ClientResponseError`
- `aiohttp.ClientConnectorError`
- `aiohttp.ClientError` (and subclasses: SSL, DNS, connection, payload, etc.)
- `aiohttp.ServerTimeoutError`
- `json.JSONDecodeError`
- `builtins.KeyError`
- `builtins.OSError` (and subclasses when saving files)

### Internal (do not catch for control flow)

- `edge_tts.srt_composer._ShouldSkipException`

---

## 10. Source map (module → errors)

| Module | Raises |
| --- | --- |
| `edge_tts.exceptions` | Defines all custom types |
| `edge_tts.communicate` | `UnknownResponse`, `UnexpectedResponse`, `NoAudioReceived`, `WebSocketError`; `TypeError`, `ValueError`, `RuntimeError`; re-raises non-403 `aiohttp.ClientResponseError`; propagates aiohttp connect/WS errors |
| `edge_tts.drm` | `SkewAdjustmentError` |
| `edge_tts.voices` | `RuntimeError` (`VoicesManager`); 403 skew via DRM; propagates `aiohttp.ClientResponseError` and other aiohttp errors; possible `json.JSONDecodeError` |
| `edge_tts.data_classes` | `TypeError`, `ValueError` (TTSConfig) |
| `edge_tts.submaker` | `ValueError` |
| `edge_tts.srt_composer` | `_ShouldSkipException` (internal only) |
| `edge_tts.util` | CLI only; catches `KeyboardInterrupt`; file I/O errors from open |
| `edge_playback.win32_playback` | `NotImplementedError` |

---

*End of reference. Prefer matching on full exception types (`isinstance`) over parsing message strings; messages are stable today but are not a formal public API contract.*
