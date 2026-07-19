from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Literal

import aiohttp
import edge_tts
from edge_tts.exceptions import (
    EdgeTTSException,
    NoAudioReceived,
    SkewAdjustmentError,
    UnexpectedResponse,
    UnknownResponse,
    WebSocketError,
)

from cache import Cache, cache_id
from config import VALID_RATES, Config

log = logging.getLogger("edge-tts-connector.tts")

VOICE_RE = re.compile(r"^[A-Za-z0-9._-]+$")
ID_RE = re.compile(r"^[0-9a-f]{32}$")
PITCH_RE = re.compile(r"^[+-]\d+Hz$")

VOICE_FRESH_S = 24 * 3600
VOICE_BACKOFF_MIN_S = 5 * 60
VOICE_BACKOFF_MAX_S = 30 * 60
CIRCUIT_STRIKES = 3
CIRCUIT_OPEN_S = 5 * 60
PREFETCH_MAX_ATTEMPTS = 2

Priority = Literal["play", "prefetch"]


class ErrorKind(str, Enum):
    BAD_REQUEST = "bad_request"
    UPSTREAM_OFFLINE = "upstream_offline"
    UPSTREAM_TRANSIENT = "upstream_transient"
    UPSTREAM_REJECT = "upstream_reject"
    INTERNAL = "internal"
    BUSY = "busy"
    VOICES_UNAVAILABLE = "voices_unavailable"


class SynthError(Exception):
    def __init__(self, kind: ErrorKind, message: str, attempts: int = 1) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.attempts = attempts


HTTP_FOR_ERROR = {
    ErrorKind.BAD_REQUEST: 400,
    ErrorKind.BUSY: 503,
    ErrorKind.UPSTREAM_OFFLINE: 503,
    ErrorKind.UPSTREAM_TRANSIENT: 502,
    ErrorKind.UPSTREAM_REJECT: 502,
    ErrorKind.INTERNAL: 500,
    ErrorKind.VOICES_UNAVAILABLE: 503,
}


def map_voice(raw: dict[str, Any]) -> dict[str, str]:
    locale = str(raw.get("Locale") or "")
    lang = locale.split("-")[0].lower() if locale else ""
    return {
        "id": str(raw.get("ShortName") or ""),
        "locale": locale,
        "lang": lang,
        "gender": str(raw.get("Gender") or ""),
        "friendlyName": str(raw.get("FriendlyName") or ""),
        "status": str(raw.get("Status") or ""),
    }


def _exc_name(exc: BaseException) -> str:
    return f"{type(exc).__module__}.{type(exc).__name__}"


def classify_exception(exc: BaseException) -> tuple[ErrorKind, bool]:
    """Return (kind, is_clock_auth_sickness) for metrics + circuit breaker."""
    if isinstance(exc, SynthError):
        return exc.kind, False

    if isinstance(exc, NoAudioReceived):
        return ErrorKind.UPSTREAM_REJECT, False
    if isinstance(exc, (UnknownResponse, UnexpectedResponse)):
        return ErrorKind.UPSTREAM_REJECT, False
    if isinstance(exc, WebSocketError):
        return ErrorKind.UPSTREAM_TRANSIENT, False
    if isinstance(exc, SkewAdjustmentError):
        return ErrorKind.UPSTREAM_OFFLINE, True

    if isinstance(exc, (TypeError, ValueError)):
        return ErrorKind.BAD_REQUEST, False
    if isinstance(exc, RuntimeError):
        return ErrorKind.INTERNAL, False

    if isinstance(exc, json.JSONDecodeError):
        return ErrorKind.UPSTREAM_REJECT, False
    if isinstance(exc, KeyError):
        return ErrorKind.UPSTREAM_REJECT, False

    if isinstance(exc, aiohttp.ClientResponseError):
        status = int(getattr(exc, "status", 0) or 0)
        if status == 403:
            return ErrorKind.UPSTREAM_OFFLINE, True
        if status == 429 or status >= 500:
            return ErrorKind.UPSTREAM_TRANSIENT, False
        if 400 <= status < 500:
            return ErrorKind.UPSTREAM_REJECT, False
        return ErrorKind.UPSTREAM_TRANSIENT, False

    if isinstance(exc, aiohttp.ClientSSLError):
        return ErrorKind.UPSTREAM_OFFLINE, False
    if isinstance(exc, aiohttp.ServerTimeoutError):
        return ErrorKind.UPSTREAM_TRANSIENT, False
    if isinstance(exc, aiohttp.ClientConnectorError):
        # DNS / refused / unreachable tend to live here
        msg = str(exc).lower()
        if any(
            s in msg
            for s in (
                "name or service not known",
                "nodename nor servname",
                "network is unreachable",
                "no route to host",
                "connection refused",
                "connect call failed",
                "getaddrinfo",
                "dns",
            )
        ):
            return ErrorKind.UPSTREAM_OFFLINE, False
        return ErrorKind.UPSTREAM_TRANSIENT, False
    if isinstance(exc, aiohttp.ClientError):
        return ErrorKind.UPSTREAM_TRANSIENT, False

    if isinstance(exc, EdgeTTSException):
        return ErrorKind.UPSTREAM_TRANSIENT, False

    if isinstance(exc, asyncio.TimeoutError):
        return ErrorKind.UPSTREAM_TRANSIENT, False

    if isinstance(exc, PermissionError):
        return ErrorKind.INTERNAL, False
    if isinstance(exc, FileNotFoundError):
        return ErrorKind.INTERNAL, False
    if isinstance(exc, OSError):
        err = getattr(exc, "errno", None)
        # Common "no path to network" errnos
        if err in {101, 113, 51, 64, 65}:
            return ErrorKind.UPSTREAM_OFFLINE, False
        if err in {111, 61}:  # connection refused
            return ErrorKind.UPSTREAM_OFFLINE, False
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return ErrorKind.UPSTREAM_TRANSIENT, False
        if isinstance(exc, ConnectionError):
            return ErrorKind.UPSTREAM_OFFLINE, False
        # Disk full / permission-ish → internal
        return ErrorKind.INTERNAL, False

    return ErrorKind.INTERNAL, False


def _retryable(kind: ErrorKind, priority: Priority) -> bool:
    if kind == ErrorKind.UPSTREAM_TRANSIENT:
        return True
    if kind == ErrorKind.UPSTREAM_OFFLINE and priority == "prefetch":
        return True  # within prefetch budget only
    return False


def _safe_message(kind: ErrorKind) -> str:
    return {
        ErrorKind.UPSTREAM_OFFLINE: "upstream unreachable",
        ErrorKind.UPSTREAM_TRANSIENT: "upstream temporary failure",
        ErrorKind.UPSTREAM_REJECT: "upstream rejected request",
        ErrorKind.INTERNAL: "internal error",
        ErrorKind.BUSY: "busy",
        ErrorKind.BAD_REQUEST: "bad request",
        ErrorKind.VOICES_UNAVAILABLE: "voice list unavailable",
    }.get(kind, "error")


def _iso_utc(ts: float | None) -> str | None:
    if ts is None:
        return None
    return (
        datetime.fromtimestamp(ts, tz=timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


@dataclass
class SynthResult:
    status: str
    id: str
    voice: str
    cached: bool


@dataclass
class VoicesSnapshot:
    voices: list[dict[str, str]]
    source: Literal["network", "cache"]
    fetched_at: float
    stale: bool


class CircuitBreaker:
    def __init__(self, strikes: int = CIRCUIT_STRIKES, open_s: float = CIRCUIT_OPEN_S) -> None:
        self.strikes = strikes
        self.open_s = open_s
        self._failures = 0
        self._open_until = 0.0
        self._lock = asyncio.Lock()

    async def check(self) -> None:
        async with self._lock:
            now = time.monotonic()
            if now < self._open_until:
                raise SynthError(
                    ErrorKind.UPSTREAM_OFFLINE,
                    "upstream circuit open (clock/auth failures)",
                )

    async def record_success(self) -> None:
        async with self._lock:
            self._failures = 0
            self._open_until = 0.0

    async def record_failure(self, clock_auth: bool) -> None:
        if not clock_auth:
            return
        async with self._lock:
            self._failures += 1
            if self._failures >= self.strikes:
                self._open_until = time.monotonic() + self.open_s
                self._failures = 0
                log.warning(
                    "circuit open for %.0fs after clock/auth failures",
                    self.open_s,
                )


class TTSService:
    def __init__(self, cfg: Config, cache: Cache) -> None:
        self.cfg = cfg
        self.cache = cache
        self._sem = asyncio.Semaphore(cfg.workers)
        self._inflight: dict[str, asyncio.Future[SynthResult]] = {}
        self._queue_waiters = 0
        self._lock = asyncio.Lock()
        self._circuit = CircuitBreaker()

        self._voices: list[dict[str, str]] = []
        self._voices_source: Literal["network", "cache"] = "cache"
        self._voices_fetched_at: float | None = None
        self._voices_lock = asyncio.Lock()
        self._voice_refresh_task: asyncio.Task[None] | None = None
        self._voice_backoff_s = float(VOICE_BACKOFF_MIN_S)

    async def start(self) -> None:
        await self._bootstrap_voices()
        self._voice_refresh_task = asyncio.create_task(
            self._voice_refresh_loop(), name="voice-refresh"
        )

    async def stop(self) -> None:
        if self._voice_refresh_task is not None:
            self._voice_refresh_task.cancel()
            try:
                await self._voice_refresh_task
            except asyncio.CancelledError:
                pass
            self._voice_refresh_task = None

    def voices_response(self) -> tuple[int, dict[str, Any]]:
        if not self._voices:
            return 503, {
                "status": "error",
                "error": ErrorKind.VOICES_UNAVAILABLE.value,
                "message": _safe_message(ErrorKind.VOICES_UNAVAILABLE),
                "voices": [],
            }
        fetched = self._voices_fetched_at or 0.0
        stale = (time.time() - fetched) > VOICE_FRESH_S if fetched else True
        return 200, {
            "voices": list(self._voices),
            "source": self._voices_source,
            "fetched_at": _iso_utc(self._voices_fetched_at),
            "stale": stale,
        }

    def _voice_gate_active(self) -> bool:
        if not self._voices or self._voices_fetched_at is None:
            return False
        return (time.time() - self._voices_fetched_at) <= VOICE_FRESH_S

    def _known_voice_ids(self) -> set[str]:
        return {v["id"] for v in self._voices if v.get("id")}

    async def _bootstrap_voices(self) -> None:
        ok = await self._fetch_voices_live()
        if ok:
            return
        loaded = self._load_voices_cache()
        if loaded:
            log.warning(
                "using disk voice cache (%d voices, fetched_at=%s)",
                len(self._voices),
                _iso_utc(self._voices_fetched_at),
            )
        else:
            log.warning("voice list unavailable (no network, no cache)")

    async def _fetch_voices_live(self) -> bool:
        try:
            raw = await edge_tts.list_voices()
            voices = [map_voice(v) for v in raw if v.get("ShortName")]
            if not voices:
                log.warning("list_voices returned empty")
                return False
            now = time.time()
            async with self._voices_lock:
                self._voices = voices
                self._voices_source = "network"
                self._voices_fetched_at = now
            self._write_voices_cache(voices, now)
            self._voice_backoff_s = float(VOICE_BACKOFF_MIN_S)
            await self._circuit.record_success()
            log.info("loaded %d voices from network", len(voices))
            return True
        except Exception as exc:
            kind, clock_auth = classify_exception(exc)
            log.warning(
                "list_voices failed: %s kind=%s",
                _exc_name(exc),
                kind.value,
            )
            if clock_auth:
                await self._circuit.record_failure(True)
            return False

    def _load_voices_cache(self) -> bool:
        path = self.cfg.voices_cache_path
        if not path.is_file():
            return False
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            voices = data.get("voices")
            fetched_at = data.get("fetched_at")
            if not isinstance(voices, list) or not voices:
                return False
            mapped: list[dict[str, str]] = []
            for v in voices:
                if isinstance(v, dict) and v.get("id"):
                    mapped.append(
                        {
                            "id": str(v.get("id") or ""),
                            "locale": str(v.get("locale") or ""),
                            "lang": str(v.get("lang") or ""),
                            "gender": str(v.get("gender") or ""),
                            "friendlyName": str(v.get("friendlyName") or ""),
                            "status": str(v.get("status") or ""),
                        }
                    )
            if not mapped:
                return False
            ts = float(fetched_at) if fetched_at is not None else path.stat().st_mtime
            self._voices = mapped
            self._voices_source = "cache"
            self._voices_fetched_at = ts
            return True
        except Exception as exc:
            log.warning("voices cache read failed: %s", _exc_name(exc))
            return False

    def _write_voices_cache(self, voices: list[dict[str, str]], fetched_at: float) -> None:
        path = self.cfg.voices_cache_path
        payload = {
            "fetched_at": fetched_at,
            "fetched_at_iso": _iso_utc(fetched_at),
            "voices": voices,
        }
        try:
            tmp = path.with_suffix(".json.part")
            tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            tmp.replace(path)
        except OSError as exc:
            log.warning("voices cache write failed: %s", _exc_name(exc))

    async def _voice_refresh_loop(self) -> None:
        while True:
            try:
                if self._voices_source == "network" and self._voices:
                    # Healthy: re-check daily-ish without hammering
                    await asyncio.sleep(VOICE_FRESH_S)
                else:
                    await asyncio.sleep(self._voice_backoff_s)
                ok = await self._fetch_voices_live()
                if not ok:
                    self._voice_backoff_s = min(
                        self._voice_backoff_s * 2, float(VOICE_BACKOFF_MAX_S)
                    )
                    self._voice_backoff_s = max(self._voice_backoff_s, float(VOICE_BACKOFF_MIN_S))
                    log.info("next voice refresh in %.0fs", self._voice_backoff_s)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("voice refresh loop error: %s", _exc_name(exc))
                await asyncio.sleep(self._voice_backoff_s)

    def validate_synth(
        self,
        text: Any,
        voice: Any,
        rate: Any,
        pitch: Any,
        priority: Any,
    ) -> tuple[str, str, str, str, Priority]:
        if not isinstance(text, str) or not text.strip():
            raise SynthError(ErrorKind.BAD_REQUEST, "text is required")
        if len(text) > self.cfg.max_text_chars:
            raise SynthError(
                ErrorKind.BAD_REQUEST,
                f"text exceeds max_text_chars ({self.cfg.max_text_chars})",
            )
        v = voice if voice else self.cfg.default_voice
        if not isinstance(v, str) or not VOICE_RE.match(v):
            raise SynthError(ErrorKind.BAD_REQUEST, "invalid voice")
        if self._voice_gate_active() and v not in self._known_voice_ids():
            raise SynthError(ErrorKind.BAD_REQUEST, "unknown voice")
        r = rate if rate is not None else "+0%"
        p = pitch if pitch is not None else "+0Hz"
        if not isinstance(r, str) or r not in VALID_RATES:
            raise SynthError(ErrorKind.BAD_REQUEST, "rate must be -50%..+100% step 10%")
        if not isinstance(p, str) or not PITCH_RE.match(p):
            raise SynthError(ErrorKind.BAD_REQUEST, "invalid pitch")
        pri: Priority = "play"
        if priority is not None:
            if priority not in ("play", "prefetch"):
                raise SynthError(ErrorKind.BAD_REQUEST, "priority must be play or prefetch")
            pri = priority
        return text, v, r, p, pri

    async def synth(
        self,
        text: Any,
        voice: Any = None,
        rate: Any = None,
        pitch: Any = None,
        priority: Any = None,
    ) -> SynthResult:
        text, voice, rate, pitch, pri = self.validate_synth(text, voice, rate, pitch, priority)
        audio_id = cache_id(rate, pitch, text)
        key = f"{voice}/{audio_id}"

        if self.cache.is_ready(voice, audio_id):
            self.cache.touch(voice, audio_id)
            return SynthResult(status="ready", id=audio_id, voice=voice, cached=True)

        await self._circuit.check()

        async with self._lock:
            existing = self._inflight.get(key)
            if existing is not None:
                fut: asyncio.Future[SynthResult] = existing
            else:
                if self._queue_waiters >= self.cfg.request_queue_max:
                    raise SynthError(ErrorKind.BUSY, "synth queue full")
                loop = asyncio.get_running_loop()
                fut = loop.create_future()
                self._inflight[key] = fut
                self._queue_waiters += 1
                asyncio.create_task(
                    self._run_synth(key, voice, audio_id, text, rate, pitch, pri, fut)
                )

        return await asyncio.shield(fut)

    async def _run_synth(
        self,
        key: str,
        voice: str,
        audio_id: str,
        text: str,
        rate: str,
        pitch: str,
        priority: Priority,
        fut: asyncio.Future[SynthResult],
    ) -> None:
        try:
            async with self._sem:
                result = await self._synth_with_retries(
                    voice, audio_id, text, rate, pitch, priority
                )
            if not fut.done():
                fut.set_result(result)
        except SynthError as exc:
            if not fut.done():
                fut.set_exception(exc)
        except Exception as exc:
            log.exception("unexpected synth failure: %s", _exc_name(exc))
            if not fut.done():
                fut.set_exception(
                    SynthError(ErrorKind.INTERNAL, "synthesis failed", attempts=1)
                )
        finally:
            async with self._lock:
                self._inflight.pop(key, None)
                self._queue_waiters = max(0, self._queue_waiters - 1)

    def _max_attempts(self, priority: Priority) -> int:
        if priority == "prefetch":
            return PREFETCH_MAX_ATTEMPTS
        return max(1, self.cfg.synth_retries)

    async def _synth_with_retries(
        self,
        voice: str,
        audio_id: str,
        text: str,
        rate: str,
        pitch: str,
        priority: Priority,
    ) -> SynthResult:
        if self.cache.is_ready(voice, audio_id):
            self.cache.touch(voice, audio_id)
            return SynthResult(status="ready", id=audio_id, voice=voice, cached=True)

        max_attempts = self._max_attempts(priority)
        attempts = 0
        last_kind = ErrorKind.UPSTREAM_TRANSIENT
        last_msg = "synthesis failed"

        while attempts < max_attempts:
            attempts += 1
            await self._circuit.check()
            part = self.cache.part_path_for(voice, audio_id)
            part.parent.mkdir(parents=True, exist_ok=True)
            self.cache.abort_part(voice, audio_id)
            try:
                await self._write_audio(text, voice, rate, pitch, part)
                if not self.cache.finalize_part(voice, audio_id):
                    raise SynthError(
                        ErrorKind.UPSTREAM_REJECT,
                        "audio too small or empty",
                        attempts=attempts,
                    )
                await self._circuit.record_success()
                log.info(
                    "synth ok voice=%s id=%s priority=%s attempts=%d",
                    voice,
                    audio_id,
                    priority,
                    attempts,
                )
                return SynthResult(status="ready", id=audio_id, voice=voice, cached=False)
            except Exception as exc:
                self.cache.abort_part(voice, audio_id)
                if isinstance(exc, SynthError) and exc.kind == ErrorKind.UPSTREAM_OFFLINE and "circuit" in exc.message:
                    raise SynthError(exc.kind, exc.message, attempts=attempts) from exc

                kind, clock_auth = classify_exception(exc)
                if isinstance(exc, SynthError):
                    kind = exc.kind
                    clock_auth = False
                last_kind = kind
                last_msg = (
                    exc.message
                    if isinstance(exc, SynthError)
                    else _safe_message(kind)
                )
                log.warning(
                    "synth fail voice=%s id=%s priority=%s attempt=%d/%d kind=%s exc=%s",
                    voice,
                    audio_id,
                    priority,
                    attempts,
                    max_attempts,
                    kind.value,
                    _exc_name(exc) if not isinstance(exc, SynthError) else kind.value,
                )
                await self._circuit.record_failure(clock_auth)

                if not _retryable(kind, priority) or attempts >= max_attempts:
                    raise SynthError(kind, last_msg, attempts=attempts) from exc
                await self._backoff(attempts)

        raise SynthError(last_kind, last_msg, attempts=attempts)

    async def _backoff(self, attempt: int) -> None:
        idx = min(attempt - 1, len(self.cfg.synth_retry_backoff_s) - 1)
        delay = self.cfg.synth_retry_backoff_s[idx]
        await asyncio.sleep(delay)

    async def _write_audio(
        self, text: str, voice: str, rate: str, pitch: str, part_path: Path
    ) -> None:
        # Fresh Communicate per attempt (stream() is single-use).
        communicate = edge_tts.Communicate(
            text,
            voice,
            rate=rate,
            pitch=pitch,
            volume="+0%",
        )
        try:
            with part_path.open("wb") as f:
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        f.write(chunk["data"])
        except Exception:
            try:
                part_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise


def validate_audio_params(voice: str, audio_id: str) -> None:
    if not VOICE_RE.match(voice):
        raise SynthError(ErrorKind.BAD_REQUEST, "invalid voice")
    if not ID_RE.match(audio_id):
        raise SynthError(ErrorKind.BAD_REQUEST, "invalid id")
