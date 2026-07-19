from __future__ import annotations

from pathlib import Path

import pytest

from cache import Cache
from config import Config


@pytest.fixture
def cache_root(tmp_path: Path) -> Path:
    root = tmp_path / "tts-cache"
    root.mkdir()
    return root


@pytest.fixture
def cache(cache_root: Path) -> Cache:
    return Cache(root=cache_root, max_bytes=10_000, min_audio_bytes=256)


@pytest.fixture
def cfg(tmp_path: Path, cache_root: Path) -> Config:
    return Config(
        host="127.0.0.1",
        port=24765,
        secret="test-secret-token",
        workers=2,
        default_voice="en-US-EmmaMultilingualNeural",
        cache_dir=cache_root,
        cache_max_bytes=10_000,
        max_text_chars=2000,
        request_queue_max=32,
        synth_retries=3,
        synth_retry_backoff_s=(0.0, 0.0, 0.0),
        min_audio_bytes=256,
        config_path=tmp_path / "config.toml",
        pidfile=tmp_path / "edge-tts-connector.pid",
        voices_cache_path=tmp_path / "voices-cache.json",
    )
