from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import aiohttp
import pytest
from edge_tts.exceptions import (
    NoAudioReceived,
    SkewAdjustmentError,
    UnexpectedResponse,
    UnknownResponse,
    WebSocketError,
)
from multidict import CIMultiDict
from yarl import URL

from cache import Cache, cache_id
from config import Config
from tts import (
    CIRCUIT_OPEN_S,
    CIRCUIT_STRIKES,
    ErrorKind,
    CircuitBreaker,
    SynthError,
    TTSService,
    _iso_utc,
    _retryable,
    classify_exception,
    map_voice,
    validate_audio_params,
)


def _conn_key(*, ssl: bool = False) -> MagicMock:
    key = MagicMock()
    key.ssl = ssl
    return key


def _client_response_error(status: int) -> aiohttp.ClientResponseError:
    info = aiohttp.RequestInfo(
        url=URL("https://example.test/"),
        method="GET",
        headers=CIMultiDict(),
        real_url=URL("https://example.test/"),
    )
    return aiohttp.ClientResponseError(info, (), status=status, message="err")


def _classify_cases() -> list[tuple[BaseException, ErrorKind, bool]]:
    return [
        (NoAudioReceived("no audio"), ErrorKind.UPSTREAM_REJECT, False),
        (UnknownResponse("u"), ErrorKind.UPSTREAM_REJECT, False),
        (UnexpectedResponse("u"), ErrorKind.UPSTREAM_REJECT, False),
        (WebSocketError("ws"), ErrorKind.UPSTREAM_TRANSIENT, False),
        (SkewAdjustmentError("skew"), ErrorKind.UPSTREAM_OFFLINE, True),
        (ValueError("bad"), ErrorKind.BAD_REQUEST, False),
        (TypeError("bad"), ErrorKind.BAD_REQUEST, False),
        (RuntimeError("boom"), ErrorKind.INTERNAL, False),
        (asyncio.TimeoutError(), ErrorKind.UPSTREAM_TRANSIENT, False),
        (PermissionError("x"), ErrorKind.INTERNAL, False),
        (_client_response_error(403), ErrorKind.UPSTREAM_OFFLINE, True),
        (_client_response_error(429), ErrorKind.UPSTREAM_TRANSIENT, False),
        (_client_response_error(503), ErrorKind.UPSTREAM_TRANSIENT, False),
        (_client_response_error(400), ErrorKind.UPSTREAM_REJECT, False),
        (
            aiohttp.ClientConnectorSSLError(_conn_key(ssl=True), OSError("ssl")),
            ErrorKind.UPSTREAM_OFFLINE,
            False,
        ),
        (aiohttp.ServerTimeoutError(), ErrorKind.UPSTREAM_TRANSIENT, False),
        (OSError(111, "Connection refused"), ErrorKind.UPSTREAM_OFFLINE, False),
        (OSError(101, "Network unreachable"), ErrorKind.UPSTREAM_OFFLINE, False),
        (BrokenPipeError(), ErrorKind.UPSTREAM_TRANSIENT, False),
        (SynthError(ErrorKind.BUSY, "busy"), ErrorKind.BUSY, False),
        (Exception("mystery"), ErrorKind.INTERNAL, False),
    ]


class _ConnectorMsg(aiohttp.ClientConnectorError):
    """aiohttp hides the OSError text in str(); force a message for classify paths."""

    def __init__(self, message: str) -> None:
        self._message = message

    def __str__(self) -> str:
        return self._message


@pytest.mark.parametrize("exc,kind,clock_auth", _classify_cases())
def test_classify_exception(exc: BaseException, kind: ErrorKind, clock_auth: bool) -> None:
    assert classify_exception(exc) == (kind, clock_auth)


def test_classify_connector_message_offline_vs_transient() -> None:
    assert classify_exception(_ConnectorMsg("Name or service not known")) == (
        ErrorKind.UPSTREAM_OFFLINE,
        False,
    )
    assert classify_exception(_ConnectorMsg("temporary blip")) == (
        ErrorKind.UPSTREAM_TRANSIENT,
        False,
    )


@pytest.mark.parametrize(
    "kind,priority,expected",
    [
        (ErrorKind.UPSTREAM_TRANSIENT, "play", True),
        (ErrorKind.UPSTREAM_TRANSIENT, "prefetch", True),
        (ErrorKind.UPSTREAM_OFFLINE, "prefetch", True),
        (ErrorKind.UPSTREAM_OFFLINE, "play", False),
        (ErrorKind.UPSTREAM_REJECT, "play", False),
        (ErrorKind.BAD_REQUEST, "play", False),
        (ErrorKind.INTERNAL, "prefetch", False),
    ],
)
def test_retryable(kind: ErrorKind, priority: str, expected: bool) -> None:
    assert _retryable(kind, priority) is expected  # type: ignore[arg-type]


def test_map_voice() -> None:
    assert map_voice(
        {
            "ShortName": "en-US-JennyNeural",
            "Locale": "en-US",
            "Gender": "Female",
            "FriendlyName": "Jenny",
            "Status": "GA",
        }
    ) == {
        "id": "en-US-JennyNeural",
        "locale": "en-US",
        "lang": "en",
        "gender": "Female",
        "friendlyName": "Jenny",
        "status": "GA",
    }
    assert map_voice({}) == {
        "id": "",
        "locale": "",
        "lang": "",
        "gender": "",
        "friendlyName": "",
        "status": "",
    }


def test_iso_utc() -> None:
    assert _iso_utc(None) is None
    assert _iso_utc(0.0) == "1970-01-01T00:00:00Z"


def test_validate_audio_params() -> None:
    validate_audio_params("en-US-EmmaMultilingualNeural", "a" * 32)
    with pytest.raises(SynthError) as ei:
        validate_audio_params("../evil", "a" * 32)
    assert ei.value.kind == ErrorKind.BAD_REQUEST
    with pytest.raises(SynthError) as ei:
        validate_audio_params("voice", "not-hex")
    assert ei.value.kind == ErrorKind.BAD_REQUEST


def _service(cfg: Config, cache: Cache, **voice_state: Any) -> TTSService:
    svc = TTSService(cfg, cache)
    if voice_state:
        svc._voices = voice_state.get("voices", [])
        svc._voices_fetched_at = voice_state.get("fetched_at")
        svc._voices_source = voice_state.get("source", "cache")
    return svc


def test_validate_synth_defaults_and_rejects(cfg: Config, cache: Cache) -> None:
    svc = _service(cfg, cache)
    text, voice, rate, pitch, pri = svc.validate_synth("hi", None, None, None, None)
    assert text == "hi"
    assert voice == cfg.default_voice
    assert rate == "+0%"
    assert pitch == "+0Hz"
    assert pri == "play"

    with pytest.raises(SynthError) as ei:
        svc.validate_synth("  ", None, None, None, None)
    assert ei.value.kind == ErrorKind.BAD_REQUEST

    with pytest.raises(SynthError) as ei:
        svc.validate_synth("x" * (cfg.max_text_chars + 1), None, None, None, None)
    assert ei.value.kind == ErrorKind.BAD_REQUEST

    with pytest.raises(SynthError) as ei:
        svc.validate_synth("hi", None, "+7%", None, None)
    assert ei.value.kind == ErrorKind.BAD_REQUEST

    with pytest.raises(SynthError) as ei:
        svc.validate_synth("hi", None, None, "0Hz", None)
    assert ei.value.kind == ErrorKind.BAD_REQUEST

    with pytest.raises(SynthError) as ei:
        svc.validate_synth("hi", None, None, None, "background")
    assert ei.value.kind == ErrorKind.BAD_REQUEST


def test_validate_synth_voice_gate(cfg: Config, cache: Cache) -> None:
    known = [{"id": "en-US-JennyNeural", "locale": "en-US", "lang": "en"}]
    svc = _service(cfg, cache, voices=known, fetched_at=time.time(), source="network")
    svc.validate_synth("hi", "en-US-JennyNeural", "+0%", "+0Hz", "play")
    with pytest.raises(SynthError) as ei:
        svc.validate_synth("hi", "en-XX-UnknownNeural", "+0%", "+0Hz", "play")
    assert ei.value.kind == ErrorKind.BAD_REQUEST
    assert "unknown voice" in ei.value.message

    # Stale / empty list → gate off
    svc_stale = _service(
        cfg,
        cache,
        voices=known,
        fetched_at=time.time() - 48 * 3600,
        source="cache",
    )
    svc_stale.validate_synth("hi", "en-XX-UnknownNeural", "+0%", "+0Hz", "play")


def test_voices_response_unavailable_and_ok(cfg: Config, cache: Cache) -> None:
    empty = _service(cfg, cache)
    status, body = empty.voices_response()
    assert status == 503
    assert body["error"] == ErrorKind.VOICES_UNAVAILABLE.value

    now = time.time()
    filled = _service(
        cfg,
        cache,
        voices=[{"id": "v1", "lang": "en"}],
        fetched_at=now,
        source="network",
    )
    status, body = filled.voices_response()
    assert status == 200
    assert body["voices"][0]["id"] == "v1"
    assert body["source"] == "network"
    assert body["stale"] is False
    assert body["fetched_at"] == _iso_utc(now)


@pytest.mark.asyncio
async def test_circuit_breaker_opens_on_clock_auth_strikes() -> None:
    br = CircuitBreaker(strikes=CIRCUIT_STRIKES, open_s=CIRCUIT_OPEN_S)
    await br.check()  # closed

    for _ in range(CIRCUIT_STRIKES - 1):
        await br.record_failure(True)
    await br.check()  # still closed

    await br.record_failure(False)  # ignored
    await br.check()

    await br.record_failure(True)  # trip
    with pytest.raises(SynthError) as ei:
        await br.check()
    assert ei.value.kind == ErrorKind.UPSTREAM_OFFLINE

    # success clears
    br._open_until = 0.0
    await br.record_success()
    await br.check()


@pytest.mark.asyncio
async def test_circuit_breaker_expires(monkeypatch: pytest.MonkeyPatch) -> None:
    br = CircuitBreaker(strikes=1, open_s=60.0)
    clock = {"t": 1000.0}
    monkeypatch.setattr("tts.time.monotonic", lambda: clock["t"])

    await br.record_failure(True)
    with pytest.raises(SynthError):
        await br.check()

    clock["t"] = 1000.0 + 60.0
    await br.check()


@pytest.mark.asyncio
async def test_synth_cache_hit_skips_upstream(cfg: Config, cache: Cache) -> None:
    svc = _service(cfg, cache)
    text, rate, pitch = "hello", "+0%", "+0Hz"
    audio_id = cache_id(rate, pitch, text)
    voice = cfg.default_voice
    final = cache.path_for(voice, audio_id)
    final.parent.mkdir(parents=True, exist_ok=True)
    final.write_bytes(b"m" * cfg.min_audio_bytes)

    svc._write_audio = AsyncMock()  # type: ignore[method-assign]
    result = await svc.synth(text, voice, rate, pitch, "play")
    assert result.cached is True
    assert result.status == "ready"
    assert result.id == audio_id
    svc._write_audio.assert_not_called()


@pytest.mark.asyncio
async def test_synth_coalesces_inflight(cfg: Config, cache: Cache) -> None:
    svc = _service(cfg, cache)
    started = asyncio.Event()
    release = asyncio.Event()
    audio_id = cache_id("+0%", "+0Hz", "same")

    async def slow_write(
        _text: str, _voice: str, _rate: str, _pitch: str, part_path: Path
    ) -> None:
        started.set()
        await release.wait()
        part_path.parent.mkdir(parents=True, exist_ok=True)
        part_path.write_bytes(b"m" * cfg.min_audio_bytes)

    svc._write_audio = slow_write  # type: ignore[method-assign]

    t1 = asyncio.create_task(svc.synth("same", None, "+0%", "+0Hz", "play"))
    await started.wait()
    t2 = asyncio.create_task(svc.synth("same", None, "+0%", "+0Hz", "play"))
    await asyncio.sleep(0)
    assert len(svc._inflight) == 1

    release.set()
    r1, r2 = await asyncio.gather(t1, t2)
    assert r1.id == r2.id == audio_id
    assert r1.cached is False
    assert cache.is_ready(cfg.default_voice, r1.id)
