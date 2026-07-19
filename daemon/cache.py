from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path


def cache_id(rate: str, pitch: str, text: str) -> str:
    payload = f"rate:{rate}\0pitch:{pitch}\0{text}".encode("utf-8")
    return hashlib.md5(payload).hexdigest()


class Cache:
    def __init__(self, root: Path, max_bytes: int, min_audio_bytes: int) -> None:
        self.root = root
        self.max_bytes = max_bytes
        self.min_audio_bytes = min_audio_bytes
        self.root.mkdir(parents=True, exist_ok=True)

    def path_for(self, voice: str, audio_id: str) -> Path:
        return self.root / voice / f"{audio_id}.mp3"

    def part_path_for(self, voice: str, audio_id: str) -> Path:
        return self.root / voice / f"{audio_id}.mp3.part"

    def is_ready(self, voice: str, audio_id: str) -> bool:
        path = self.path_for(voice, audio_id)
        if not path.is_file():
            return False
        size = path.stat().st_size
        if size < self.min_audio_bytes:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
            return False
        return True

    def touch(self, voice: str, audio_id: str) -> None:
        path = self.path_for(voice, audio_id)
        if path.is_file():
            now = time.time()
            os.utime(path, (now, now))

    def finalize_part(self, voice: str, audio_id: str) -> bool:
        part = self.part_path_for(voice, audio_id)
        final = self.path_for(voice, audio_id)
        if not part.is_file():
            return False
        size = part.stat().st_size
        if size < self.min_audio_bytes:
            try:
                part.unlink(missing_ok=True)
            except OSError:
                pass
            return False
        final.parent.mkdir(parents=True, exist_ok=True)
        os.replace(part, final)
        self.enforce_lru()
        return True

    def abort_part(self, voice: str, audio_id: str) -> None:
        part = self.part_path_for(voice, audio_id)
        try:
            part.unlink(missing_ok=True)
        except OSError:
            pass

    def _iter_mp3s(self) -> list[Path]:
        if not self.root.is_dir():
            return []
        return [p for p in self.root.rglob("*.mp3") if p.is_file() and not p.name.endswith(".part")]

    def stats(self) -> dict[str, int]:
        files = self._iter_mp3s()
        total = 0
        count = 0
        for p in files:
            try:
                total += p.stat().st_size
                count += 1
            except OSError:
                continue
        return {"bytes": total, "files": count}

    def clear(self) -> None:
        if not self.root.is_dir():
            return
        for p in self.root.rglob("*"):
            if p.is_file():
                try:
                    p.unlink()
                except OSError:
                    pass
        for p in sorted(self.root.rglob("*"), reverse=True):
            if p.is_dir():
                try:
                    p.rmdir()
                except OSError:
                    pass

    def enforce_lru(self) -> None:
        files = self._iter_mp3s()
        entries: list[tuple[float, int, Path]] = []
        total = 0
        for p in files:
            try:
                st = p.stat()
            except OSError:
                continue
            entries.append((st.st_mtime, st.st_size, p))
            total += st.st_size
        if total <= self.max_bytes:
            return
        entries.sort(key=lambda x: x[0])
        for _mtime, size, path in entries:
            if total <= self.max_bytes:
                break
            try:
                path.unlink(missing_ok=True)
                total -= size
            except OSError:
                continue
