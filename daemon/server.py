from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
from pathlib import Path
from typing import Any

from aiohttp import web

from cache import Cache
from config import VERSION, load_config
from tts import HTTP_FOR_ERROR, SynthError, TTSService, validate_audio_params

log = logging.getLogger("edge-tts-connector")


def _cors_origin(request: web.Request) -> str | None:
    origin = request.headers.get("Origin", "")
    if origin.startswith("chrome-extension://") or origin.startswith("moz-extension://"):
        return origin
    return None


@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        origin = _cors_origin(request)
        if origin is None and request.headers.get("Origin"):
            return web.Response(status=403, text="origin not allowed")
        headers = {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "X-Auth-Token, Content-Type",
            "Access-Control-Max-Age": "86400",
        }
        if origin:
            headers["Access-Control-Allow-Origin"] = origin
        return web.Response(status=204, headers=headers)

    resp = await handler(request)
    origin = _cors_origin(request)
    if origin:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Headers"] = "X-Auth-Token, Content-Type"
    return resp


@web.middleware
async def auth_middleware(request: web.Request, handler):
    if request.path == "/health" or request.method == "OPTIONS":
        return await handler(request)
    cfg = request.app["cfg"]
    token = request.headers.get("X-Auth-Token", "")
    if token != cfg.secret:
        return error_json("unauthorized", "unauthorized", 401)
    return await handler(request)


def error_json(
    error: str,
    message: str,
    status: int,
    *,
    attempts: int | None = None,
    extra: dict[str, Any] | None = None,
) -> web.Response:
    body: dict[str, Any] = {
        "status": "error",
        "error": error,
        "message": message,
    }
    if attempts is not None:
        body["attempts"] = attempts
    if extra:
        body.update(extra)
    return web.json_response(body, status=status)


def synth_error_response(exc: SynthError) -> web.Response:
    return error_json(
        exc.kind.value,
        exc.message,
        HTTP_FOR_ERROR[exc.kind],
        attempts=exc.attempts,
    )


async def handle_health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "version": VERSION})


async def handle_voices(request: web.Request) -> web.Response:
    tts: TTSService = request.app["tts"]
    status, body = tts.voices_response()
    return web.json_response(body, status=status)


async def handle_synth(request: web.Request) -> web.Response:
    tts: TTSService = request.app["tts"]
    try:
        data = await request.json()
    except Exception:
        return error_json("bad_request", "invalid json", 400)
    if not isinstance(data, dict):
        return error_json("bad_request", "invalid json", 400)
    try:
        result = await tts.synth(
            data.get("text"),
            data.get("voice"),
            data.get("rate"),
            data.get("pitch"),
            data.get("priority"),
        )
    except SynthError as exc:
        return synth_error_response(exc)
    return web.json_response(
        {
            "status": result.status,
            "id": result.id,
            "voice": result.voice,
            "cached": result.cached,
        }
    )


async def handle_audio(request: web.Request) -> web.Response:
    cache: Cache = request.app["cache"]
    voice = request.match_info["voice"]
    audio_id = request.match_info["id"]
    try:
        validate_audio_params(voice, audio_id)
    except SynthError as exc:
        return synth_error_response(exc)
    if not cache.is_ready(voice, audio_id):
        return error_json("not_found", "audio not found", 404)
    path = cache.path_for(voice, audio_id)
    cache.touch(voice, audio_id)
    return web.FileResponse(path, headers={"Content-Type": "audio/mpeg"})


async def handle_cache_clear(request: web.Request) -> web.Response:
    cache: Cache = request.app["cache"]
    cache.clear()
    return web.json_response({"ok": True})


async def handle_cache_stats(request: web.Request) -> web.Response:
    cache: Cache = request.app["cache"]
    return web.json_response(cache.stats())


def build_app(cfg, cache: Cache, tts: TTSService) -> web.Application:
    app = web.Application(middlewares=[cors_middleware, auth_middleware])
    app["cfg"] = cfg
    app["cache"] = cache
    app["tts"] = tts
    app.router.add_get("/health", handle_health)
    app.router.add_get("/voices", handle_voices)
    app.router.add_post("/v1/synth", handle_synth)
    app.router.add_get("/audio/{voice}/{id}.mp3", handle_audio)
    app.router.add_post("/v1/cache/clear", handle_cache_clear)
    app.router.add_get("/v1/cache/stats", handle_cache_stats)
    return app


async def _on_startup(app: web.Application) -> None:
    tts: TTSService = app["tts"]
    await tts.start()


async def _on_cleanup(app: web.Application) -> None:
    tts: TTSService = app["tts"]
    await tts.stop()


def _write_pid(pidfile: Path) -> None:
    pidfile.write_text(str(os.getpid()) + "\n", encoding="utf-8")


def _remove_pid(pidfile: Path) -> None:
    try:
        pidfile.unlink(missing_ok=True)
    except OSError:
        pass


async def run_server(cfg) -> None:
    cache = Cache(cfg.cache_dir, cfg.cache_max_bytes, cfg.min_audio_bytes)
    tts = TTSService(cfg, cache)
    app = build_app(cfg, cache, tts)
    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)

    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, cfg.host, cfg.port, reuse_address=True)
    try:
        await site.start()
    except OSError as exc:
        log.error("bind failed on %s:%s: %s", cfg.host, cfg.port, exc)
        await runner.cleanup()
        raise SystemExit(1) from exc

    _write_pid(cfg.pidfile)
    log.info("listening on http://%s:%s", cfg.host, cfg.port)

    stop = asyncio.Event()

    def _stop(*_args: object) -> None:
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _stop)
        except NotImplementedError:
            pass

    await stop.wait()
    log.info("shutting down")
    await runner.cleanup()
    _remove_pid(cfg.pidfile)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="edge-tts-connector daemon")
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--pidfile", type=Path, default=None)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    cfg = load_config(args.config, args.pidfile)
    try:
        asyncio.run(run_server(cfg))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
