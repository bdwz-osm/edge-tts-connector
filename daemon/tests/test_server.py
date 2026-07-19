from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from cache import Cache, cache_id
from config import VERSION, Config
from server import build_app
from tts import ErrorKind, SynthError, SynthResult, TTSService


@pytest.fixture
async def client(cfg: Config, cache: Cache):
    tts = MagicMock(spec=TTSService)
    tts.voices_response.return_value = (
        200,
        {
            "voices": [{"id": "en-US-JennyNeural", "lang": "en"}],
            "source": "cache",
            "fetched_at": "1970-01-01T00:00:00Z",
            "stale": True,
        },
    )

    async def synth(
        text: Any,
        voice: Any = None,
        rate: Any = None,
        pitch: Any = None,
        priority: Any = None,
    ) -> SynthResult:
        if text == "boom":
            raise SynthError(ErrorKind.UPSTREAM_REJECT, "upstream rejected request", attempts=1)
        if not isinstance(text, str) or not text.strip():
            raise SynthError(ErrorKind.BAD_REQUEST, "text is required")
        aid = cache_id(rate or "+0%", pitch or "+0Hz", text)
        v = voice or cfg.default_voice
        return SynthResult(status="ready", id=aid, voice=v, cached=False)

    tts.synth.side_effect = synth
    app = build_app(cfg, cache, tts)
    server = TestServer(app)
    api = TestClient(server)
    await api.start_server()
    api.tts = tts  # type: ignore[attr-defined]
    try:
        yield api
    finally:
        await api.close()


def _auth(cfg: Config) -> dict[str, str]:
    return {"X-Auth-Token": cfg.secret}


async def test_health_open_no_auth(client: TestClient) -> None:
    resp = await client.get("/health")
    assert resp.status == 200
    body = await resp.json()
    assert body == {"ok": True, "version": VERSION}


async def test_auth_required(client: TestClient, cfg: Config) -> None:
    resp = await client.get("/voices")
    assert resp.status == 401
    body = await resp.json()
    assert body["error"] == "unauthorized"

    resp = await client.get("/voices", headers={"X-Auth-Token": "wrong"})
    assert resp.status == 401

    resp = await client.get("/voices", headers=_auth(cfg))
    assert resp.status == 200


async def test_cors_extension_origin(client: TestClient, cfg: Config) -> None:
    origin = "chrome-extension://abcdefghijklmnop"
    resp = await client.get("/health", headers={"Origin": origin})
    assert resp.status == 200
    assert resp.headers["Access-Control-Allow-Origin"] == origin

    resp = await client.options(
        "/v1/synth",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "X-Auth-Token, Content-Type",
        },
    )
    assert resp.status == 204
    assert resp.headers["Access-Control-Allow-Origin"] == origin
    assert "X-Auth-Token" in resp.headers["Access-Control-Allow-Headers"]


async def test_cors_rejects_foreign_origin_preflight(client: TestClient) -> None:
    resp = await client.options(
        "/v1/synth",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert resp.status == 403


async def test_synth_ok_and_errors(client: TestClient, cfg: Config) -> None:
    resp = await client.post(
        "/v1/synth",
        json={"text": "hello", "rate": "+0%", "pitch": "+0Hz"},
        headers=_auth(cfg),
    )
    assert resp.status == 200
    body = await resp.json()
    assert body["status"] == "ready"
    assert body["cached"] is False
    assert len(body["id"]) == 32

    resp = await client.post(
        "/v1/synth",
        data="not-json",
        headers={**_auth(cfg), "Content-Type": "application/json"},
    )
    assert resp.status == 400

    resp = await client.post(
        "/v1/synth",
        json={"text": "boom"},
        headers=_auth(cfg),
    )
    assert resp.status == 502
    body = await resp.json()
    assert body["error"] == "upstream_reject"
    assert body["attempts"] == 1


async def test_audio_serve_and_not_found(client: TestClient, cfg: Config, cache: Cache) -> None:
    voice = "en-US-EmmaMultilingualNeural"
    audio_id = "a" * 32
    path = cache.path_for(voice, audio_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"m" * cfg.min_audio_bytes)

    resp = await client.get(f"/audio/{voice}/{audio_id}.mp3", headers=_auth(cfg))
    assert resp.status == 200
    assert resp.headers["Content-Type"].startswith("audio/mpeg")
    assert await resp.read() == b"m" * cfg.min_audio_bytes

    resp = await client.get(f"/audio/{voice}/{'b' * 32}.mp3", headers=_auth(cfg))
    assert resp.status == 404

    resp = await client.get(f"/audio/bad voice/{audio_id}.mp3", headers=_auth(cfg))
    assert resp.status == 400


async def test_cache_stats_and_clear(client: TestClient, cfg: Config, cache: Cache) -> None:
    voice = "v"
    audio_id = "c" * 32
    p = cache.path_for(voice, audio_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"m" * cfg.min_audio_bytes)

    resp = await client.get("/v1/cache/stats", headers=_auth(cfg))
    assert resp.status == 200
    stats = await resp.json()
    assert stats["files"] == 1
    assert stats["bytes"] == cfg.min_audio_bytes

    resp = await client.post("/v1/cache/clear", headers=_auth(cfg))
    assert resp.status == 200
    assert (await resp.json()) == {"ok": True}
    assert cache.stats() == {"bytes": 0, "files": 0}
