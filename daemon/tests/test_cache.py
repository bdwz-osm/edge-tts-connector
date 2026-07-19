from __future__ import annotations

import os
import time
from pathlib import Path

from cache import Cache, cache_id


def test_cache_id_stable_and_sensitive() -> None:
    a = cache_id("+0%", "+0Hz", "hello")
    b = cache_id("+0%", "+0Hz", "hello")
    assert a == b
    assert len(a) == 32
    assert all(c in "0123456789abcdef" for c in a)

    assert cache_id("+10%", "+0Hz", "hello") != a
    assert cache_id("+0%", "+1Hz", "hello") != a
    assert cache_id("+0%", "+0Hz", "Hello") != a


def test_path_layout(cache: Cache) -> None:
    assert cache.path_for("en-US-X", "a" * 32) == cache.root / "en-US-X" / ("a" * 32 + ".mp3")
    assert cache.part_path_for("en-US-X", "a" * 32) == (
        cache.root / "en-US-X" / ("a" * 32 + ".mp3.part")
    )


def test_finalize_rejects_undersized_part(cache: Cache) -> None:
    voice, audio_id = "v", "b" * 32
    part = cache.part_path_for(voice, audio_id)
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(b"x" * (cache.min_audio_bytes - 1))

    assert cache.finalize_part(voice, audio_id) is False
    assert not part.exists()
    assert not cache.path_for(voice, audio_id).exists()


def test_finalize_promotes_good_part(cache: Cache) -> None:
    voice, audio_id = "v", "c" * 32
    part = cache.part_path_for(voice, audio_id)
    part.parent.mkdir(parents=True, exist_ok=True)
    payload = b"m" * cache.min_audio_bytes
    part.write_bytes(payload)

    assert cache.finalize_part(voice, audio_id) is True
    final = cache.path_for(voice, audio_id)
    assert final.read_bytes() == payload
    assert not part.exists()
    assert cache.is_ready(voice, audio_id)


def test_finalize_missing_part(cache: Cache) -> None:
    assert cache.finalize_part("v", "d" * 32) is False


def test_is_ready_purges_poison_final(cache: Cache) -> None:
    voice, audio_id = "v", "e" * 32
    final = cache.path_for(voice, audio_id)
    final.parent.mkdir(parents=True, exist_ok=True)
    final.write_bytes(b"tiny")

    assert cache.is_ready(voice, audio_id) is False
    assert not final.exists()


def test_abort_part(cache: Cache) -> None:
    voice, audio_id = "v", "f" * 32
    part = cache.part_path_for(voice, audio_id)
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(b"partial")
    cache.abort_part(voice, audio_id)
    assert not part.exists()
    cache.abort_part(voice, audio_id)  # idempotent


def test_touch_updates_mtime(cache: Cache) -> None:
    voice, audio_id = "v", "g" * 32
    final = cache.path_for(voice, audio_id)
    final.parent.mkdir(parents=True, exist_ok=True)
    final.write_bytes(b"m" * cache.min_audio_bytes)
    old = time.time() - 3600
    os.utime(final, (old, old))
    before = final.stat().st_mtime
    cache.touch(voice, audio_id)
    assert final.stat().st_mtime > before


def test_enforce_lru_evicts_oldest(cache_root: Path) -> None:
    cache = Cache(root=cache_root, max_bytes=600, min_audio_bytes=10)
    voice = "v"
    paths: list[Path] = []
    now = time.time()
    for i, audio_id in enumerate(["a" * 32, "b" * 32, "c" * 32]):
        p = cache.path_for(voice, audio_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"m" * 250)
        os.utime(p, (now - 30 + i, now - 30 + i))
        paths.append(p)

    cache.enforce_lru()
    assert not paths[0].exists()
    assert paths[1].exists()
    assert paths[2].exists()
    assert cache.stats()["bytes"] == 500
    assert cache.stats()["files"] == 2


def test_clear_removes_files_and_dirs(cache: Cache) -> None:
    voice, audio_id = "v", "h" * 32
    final = cache.path_for(voice, audio_id)
    final.parent.mkdir(parents=True, exist_ok=True)
    final.write_bytes(b"m" * cache.min_audio_bytes)
    cache.clear()
    assert cache.stats() == {"bytes": 0, "files": 0}
    assert not any(cache.root.rglob("*"))


def test_iter_skips_part_files(cache: Cache) -> None:
    voice = "v"
    good = cache.path_for(voice, "i" * 32)
    part = cache.part_path_for(voice, "j" * 32)
    good.parent.mkdir(parents=True, exist_ok=True)
    good.write_bytes(b"m" * cache.min_audio_bytes)
    part.write_bytes(b"m" * cache.min_audio_bytes)
    assert cache.stats()["files"] == 1
