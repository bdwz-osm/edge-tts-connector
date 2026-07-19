from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any

import edge_tts

from cache import Cache, cache_id
from config import VALID_RATES, Config

log = logging.getLogger("edge-tts-connector.tts")

VOICE_RE = re.compile(r"^[A-Za-z0-9._-]+$")
ID_RE = re.compile(r"^[0-9a-f]{32}$")
PITCH_RE = re.compile(r"^[+-]\d+Hz$")


class ErrorKind(str, Enum):
    BAD_REQUEST = "bad_request"
    UPSTREAM_OFFLINE = "upstream_offline"
    UPSTREAM_TRANSIENT = "upstream_transient"
    UPSTREAM_REJECT = "upstream_reject"
    TIMEOUT = "timeout"
    INTERNAL = "internal"
    BUSY = "busy"


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
    ErrorKind.TIMEOUT: 504,
    ErrorKind.INTERNAL: 500,
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


def classify_exception(exc: BaseException) -> ErrorKind:
    if isinstance(exc, asyncio.TimeoutError):
        return ErrorKind.TIMEOUT
    if isinstance(exc, edge_tts.exceptions.NoAudioReceived):
        return ErrorKind.UPSTREAM_REJECT
    if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
        err = getattr(exc, "errno", None)
        # Common offline / unreachable signals
        if err in {101, 111, 113, 51, 61, 64, 65} or isinstance(exc, ConnectionRefusedError):
            return ErrorKind.UPSTREAM_OFFLINE
        name = type(exc).__name__
        msg = str(exc).lower()
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return ErrorKind.UPSTREAM_TRANSIENT
        if "name or service not known" in msg or "nodename nor servname" in msg:
            return ErrorKind.UPSTREAM_OFFLINE
        if "temporary failure" in msg or "try again" in msg:
            return ErrorKind.UPSTREAM_TRANSIENT
        if "network is unreachable" in msg or "no route to host" in msg:
            return ErrorKind.UPSTREAM_OFFLINE
        if name in {"gaierror", "DNSError"}:
            return ErrorKind.UPSTREAM_OFFLINE
        return ErrorKind.UPSTREAM_TRANSIENT
    # aiohttp / websockets style
    msg = str(exc).lower()
    mod = type(exc).__module__ or ""
    if "aiohttp" in mod or "websocket" in mod:
        if "cannot connect" in msg or "getaddrinfo" in msg or "name resolution" in msg:
            return ErrorKind.UPSTREAM_OFFLINE
        return ErrorKind.UPSTREAM_TRANSIENT
    if "no audio" in msg:
        return ErrorKind.UPSTREAM_REJECT
    return ErrorKind.INTERNAL


@dataclass
class SynthResult:
    status: str
    id: str
    voice: str
    cached: bool


class TTSService:
    def __init__(self, cfg: Config, cache: Cache) -> None:
        self.cfg = cfg
        self.cache = cache
        self._sem = asyncio.Semaphore(cfg.workers)
        self._inflight: dict[str, asyncio.Future[SynthResult]] = {}
        self._queue_waiters = 0
        self._voices: list[dict[str, str]] = []
        self._lock = asyncio.Lock()

    async def preload_voices(self) -> None:
        try:
            raw = await edge_tts.list_voices()
            self._voices = [map_voice(v) for v in raw if v.get("ShortName")]
            log.info("loaded %d voices", len(self._voices))
        except Exception as exc:  # soft-fail
            log.warning("voice preload failed: %s", type(exc).__name__)
            self._voices = []

    def voices(self) -> list[dict[str, str]]:
        return list(self._voices)

    def validate_synth(
        self, text: str, voice: str | None, rate: str | None, pitch: str | None
    ) -> tuple[str, str, str, str]:
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
        r = rate if rate is not None else "+0%"
        p = pitch if pitch is not None else "+0Hz"
        if not isinstance(r, str) or r not in VALID_RATES:
            raise SynthError(ErrorKind.BAD_REQUEST, "rate must be -50%..+100% step 10%")
        if not isinstance(p, str) or not PITCH_RE.match(p):
            raise SynthError(ErrorKind.BAD_REQUEST, "invalid pitch")
        return text, v, r, p

    async def synth(
        self, text: str, voice: str | None, rate: str | None, pitch: str | None
    ) -> SynthResult:
        text, voice, rate, pitch = self.validate_synth(text, voice, rate, pitch)
        audio_id = cache_id(rate, pitch, text)
        key = f"{voice}/{audio_id}"

        if self.cache.is_ready(voice, audio_id):
            self.cache.touch(voice, audio_id)
            return SynthResult(status="ready", id=audio_id, voice=voice, cached=True)

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
                asyncio.create_task(self._run_synth(key, voice, audio_id, text, rate, pitch, fut))

        return await asyncio.shield(fut)

    async def _run_synth(
        self,
        key: str,
        voice: str,
        audio_id: str,
        text: str,
        rate: str,
        pitch: str,
        fut: asyncio.Future[SynthResult],
    ) -> None:
        try:
            async with self._sem:
                result = await self._synth_with_retries(voice, audio_id, text, rate, pitch)
            if not fut.done():
                fut.set_result(result)
        except SynthError as exc:
            if not fut.done():
                fut.set_exception(exc)
        except Exception as exc:
            if not fut.done():
                fut.set_exception(SynthError(ErrorKind.INTERNAL, "synthesis failed", attempts=1))
            log.exception("unexpected synth failure: %s", type(exc).__name__)
        finally:
            async with self._lock:
                self._inflight.pop(key, None)
                self._queue_waiters = max(0, self._queue_waiters - 1)

    async def _synth_with_retries(
        self, voice: str, audio_id: str, text: str, rate: str, pitch: str
    ) -> SynthResult:
        if self.cache.is_ready(voice, audio_id):
            self.cache.touch(voice, audio_id)
            return SynthResult(status="ready", id=audio_id, voice=voice, cached=True)

        attempts = 0
        last_kind = ErrorKind.UPSTREAM_TRANSIENT
        last_msg = "synthesis failed"
        max_attempts = max(1, self.cfg.synth_retries)

        while attempts < max_attempts:
            attempts += 1
            part = self.cache.part_path_for(voice, audio_id)
            part.parent.mkdir(parents=True, exist_ok=True)
            self.cache.abort_part(voice, audio_id)
            try:
                await asyncio.wait_for(
                    self._write_audio(text, voice, rate, pitch, part),
                    timeout=self.cfg.synth_timeout_s,
                )
                if not self.cache.finalize_part(voice, audio_id):
                    raise SynthError(
                        ErrorKind.UPSTREAM_REJECT,
                        "audio too small or empty",
                        attempts=attempts,
                    )
                return SynthResult(status="ready", id=audio_id, voice=voice, cached=False)
            except SynthError as exc:
                self.cache.abort_part(voice, audio_id)
                last_kind = exc.kind
                last_msg = exc.message
                if exc.kind == ErrorKind.UPSTREAM_OFFLINE:
                    raise SynthError(exc.kind, exc.message, attempts=attempts) from exc
                if exc.kind in (ErrorKind.UPSTREAM_REJECT, ErrorKind.BAD_REQUEST, ErrorKind.INTERNAL):
                    raise SynthError(exc.kind, exc.message, attempts=attempts) from exc
                if attempts >= max_attempts:
                    break
                await self._backoff(attempts)
            except Exception as exc:
                self.cache.abort_part(voice, audio_id)
                kind = classify_exception(exc)
                last_kind = kind
                last_msg = _safe_message(kind)
                if kind == ErrorKind.UPSTREAM_OFFLINE:
                    raise SynthError(kind, last_msg, attempts=attempts) from exc
                if kind in (ErrorKind.UPSTREAM_REJECT, ErrorKind.INTERNAL):
                    raise SynthError(kind, last_msg, attempts=attempts) from exc
                if attempts >= max_attempts:
                    break
                await self._backoff(attempts)

        raise SynthError(last_kind, last_msg, attempts=attempts)

    async def _backoff(self, attempt: int) -> None:
        idx = min(attempt - 1, len(self.cfg.synth_retry_backoff_s) - 1)
        delay = self.cfg.synth_retry_backoff_s[idx]
        await asyncio.sleep(delay)

    async def _write_audio(
        self, text: str, voice: str, rate: str, pitch: str, part_path
    ) -> None:
        communicate = edge_tts.Communicate(
            text,
            voice,
            rate=rate,
            pitch=pitch,
            volume="+0%",
        )
        # stream to .part; never leave partial as final
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


def _safe_message(kind: ErrorKind) -> str:
    return {
        ErrorKind.UPSTREAM_OFFLINE: "upstream unreachable",
        ErrorKind.UPSTREAM_TRANSIENT: "upstream temporary failure",
        ErrorKind.UPSTREAM_REJECT: "upstream rejected request",
        ErrorKind.TIMEOUT: "synthesis timed out",
        ErrorKind.INTERNAL: "internal error",
        ErrorKind.BUSY: "busy",
        ErrorKind.BAD_REQUEST: "bad request",
    }.get(kind, "error")


def validate_audio_params(voice: str, audio_id: str) -> None:
    if not VOICE_RE.match(voice):
        raise SynthError(ErrorKind.BAD_REQUEST, "invalid voice")
    if not ID_RE.match(audio_id):
        raise SynthError(ErrorKind.BAD_REQUEST, "invalid id")
