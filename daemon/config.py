from __future__ import annotations

import re
import secrets
import socket
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

VERSION = "0.1.0"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 24765

VALID_RATES = tuple(f"{i:+d}%" for i in range(-50, 101, 10))

_CONFIG_HEADER = """\
# edge-tts-connector daemon config
# Uncomment a line under a section to override the built-in default.
# File mode should stay 0600 (run.sh enforces this on create/update).
"""


@dataclass(frozen=True)
class Opt:
    """One config knob: section.key in TOML ↔ flat internal name."""

    section: str
    key: str
    flat: str
    default: Any
    help: str
    # If set, value is written active (not commented) when generating config.
    required: bool = False


# Single source of truth for defaults, TOML paths, and generated config.toml.
OPTIONS: tuple[Opt, ...] = (
    Opt(
        "auth",
        "secret",
        "secret",
        "",
        "Shared secret for the X-Auth-Token header (extension options).",
        required=True,
    ),
    Opt(
        "server",
        "host",
        "host",
        DEFAULT_HOST,
        "Bind address — must be loopback.",
    ),
    Opt(
        "server",
        "port",
        "port",
        DEFAULT_PORT,
        "Listen port (fixed 24765 in v1 unless overridden).",
    ),
    Opt(
        "synth",
        "workers",
        "workers",
        2,
        "Concurrent edge-tts workers (1–3).",
    ),
    Opt(
        "synth",
        "default_voice",
        "default_voice",
        "en-US-EmmaMultilingualNeural",
        "Used when a synth request omits voice.",
    ),
    Opt(
        "synth",
        "max_text_chars",
        "max_text_chars",
        2000,
        "Max characters per synth request.",
    ),
    Opt(
        "synth",
        "request_queue_max",
        "request_queue_max",
        32,
        "Max distinct in-flight synth jobs before HTTP 503 busy.",
    ),
    Opt(
        "synth",
        "timeout_s",
        "synth_timeout_s",
        90,
        "Per-attempt synthesis timeout (seconds).",
    ),
    Opt(
        "synth",
        "retries",
        "synth_retries",
        3,
        "Attempts for transient upstream failures (offline is not retried).",
    ),
    Opt(
        "synth",
        "retry_backoff_s",
        "synth_retry_backoff_s",
        [0.5, 1.5, 3.0],
        "Backoff seconds between retries (last value reused if retries > length).",
    ),
    Opt(
        "synth",
        "min_audio_bytes",
        "min_audio_bytes",
        256,
        "Reject / never finalize audio smaller than this (bytes).",
    ),
    Opt(
        "cache",
        "dir",
        "cache_dir",
        "tts-cache",
        "MP3 cache root (relative paths resolved from this file's directory).",
    ),
    Opt(
        "cache",
        "max_bytes",
        "cache_max_bytes",
        1073741824,
        "LRU cap in bytes (oldest by mtime evicted first).",
    ),
)

DEFAULTS: dict[str, Any] = {o.flat: o.default for o in OPTIONS if not o.required}
_SECTION_MAP: dict[tuple[str, str], str] = {(o.section, o.key): o.flat for o in OPTIONS}
_SECTION_ORDER: tuple[str, ...] = tuple(dict.fromkeys(o.section for o in OPTIONS))


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    secret: str
    workers: int
    default_voice: str
    cache_dir: Path
    cache_max_bytes: int
    max_text_chars: int
    request_queue_max: int
    synth_timeout_s: float
    synth_retries: int
    synth_retry_backoff_s: tuple[float, ...]
    min_audio_bytes: int
    config_path: Path
    pidfile: Path


@dataclass(frozen=True)
class EnsureResult:
    data: dict
    created: bool
    secret_generated: bool
    secret: str


def default_config_path() -> Path:
    return Path(__file__).resolve().parent.parent / "config.toml"


def default_pidfile_path() -> Path:
    return Path(__file__).resolve().parent / "edge-tts-connector.pid"


def _is_loopback(host: str) -> bool:
    if host in ("127.0.0.1", "::1"):
        return True
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return False
    for info in infos:
        ip = info[4][0]
        try:
            if not ipaddress_is_loopback(ip):
                return False
        except ValueError:
            return False
    return bool(infos)


def ipaddress_is_loopback(ip: str) -> bool:
    import ipaddress

    return ipaddress.ip_address(ip).is_loopback


def _toml_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _toml_literal(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return f'"{_toml_escape(value)}"'
    if isinstance(value, list):
        return "[ " + ", ".join(_toml_literal(v) for v in value) + " ]"
    raise TypeError(f"unsupported config default type: {type(value)!r}")


def _valid_secret(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s or s == "<generated>":
        return None
    return s


def flatten_toml(raw: dict) -> dict:
    """Flatten sectioned TOML; also accept legacy flat keys."""
    out: dict = {}
    for key, val in raw.items():
        if isinstance(val, dict):
            for sub_k, sub_v in val.items():
                flat = _SECTION_MAP.get((key, sub_k))
                if flat is not None:
                    out[flat] = sub_v
            continue
        if key in DEFAULTS or key == "secret":
            out[key] = val
    return out


def render_full_config(secret: str) -> str:
    """Build config.toml from OPTIONS; only the file header is fixed prose."""
    lines = [_CONFIG_HEADER.rstrip(), ""]
    by_section: dict[str, list[Opt]] = {s: [] for s in _SECTION_ORDER}
    for opt in OPTIONS:
        by_section[opt.section].append(opt)

    for section in _SECTION_ORDER:
        lines.append(f"[{section}]")
        for opt in by_section[section]:
            lines.append(f"# {opt.help}")
            if opt.required:
                value = secret if opt.flat == "secret" else opt.default
                lines.append(f"{opt.key} = {_toml_literal(value)}")
            else:
                lines.append(f"# {opt.key} = {_toml_literal(opt.default)}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def write_full_config(config_path: Path, secret: str) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(render_full_config(secret), encoding="utf-8")
    config_path.chmod(0o600)


_SECRET_LINE_RE = re.compile(
    r'(?m)^([ \t]*)secret[ \t]*=[ \t]*(?:"[^"]*"|\'[^\']*\'|[^\n#]+)'
)
_AUTH_HEADER_RE = re.compile(r"(?m)^[ \t]*\[auth\][ \t]*(?:#.*)?$")


def inject_secret(text: str, secret: str) -> str:
    """Set auth.secret in existing TOML text, preserving comments/layout."""
    line = f'secret = "{_toml_escape(secret)}"'
    if _SECRET_LINE_RE.search(text):
        return _SECRET_LINE_RE.sub(rf"\1{line}", text, count=1)
    m = _AUTH_HEADER_RE.search(text)
    if m:
        insert_at = m.end()
        return text[:insert_at] + "\n" + line + text[insert_at:]
    block = f"[auth]\n{line}\n\n"
    return block + text


def ensure_config(config_path: Path) -> EnsureResult:
    """Load or create config.toml; ensure a usable secret exists."""
    if not config_path.is_file():
        secret = secrets.token_urlsafe(32)
        write_full_config(config_path, secret)
        return EnsureResult(
            data={"secret": secret},
            created=True,
            secret_generated=True,
            secret=secret,
        )

    text = config_path.read_text(encoding="utf-8")
    try:
        raw = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise SystemExit(f"invalid config.toml: {exc}") from exc
    if not isinstance(raw, dict):
        raise SystemExit(f"invalid config: {config_path}")

    flat = flatten_toml(raw)
    secret = _valid_secret(flat.get("secret"))
    if secret is not None:
        return EnsureResult(
            data=flat,
            created=False,
            secret_generated=False,
            secret=secret,
        )

    secret = secrets.token_urlsafe(32)
    new_text = inject_secret(text, secret)
    config_path.write_text(new_text, encoding="utf-8")
    try:
        config_path.chmod(0o600)
    except OSError:
        pass
    flat["secret"] = secret
    return EnsureResult(
        data=flat,
        created=False,
        secret_generated=True,
        secret=secret,
    )


def load_config(config_path: Path | None = None, pidfile: Path | None = None) -> Config:
    config_path = config_path or default_config_path()
    pidfile = pidfile or default_pidfile_path()
    result = ensure_config(config_path)
    if result.secret_generated:
        if result.created:
            print_secret_event("created", result.secret, config_path)
        else:
            print_secret_event("injected", result.secret, config_path)

    merged = {**DEFAULTS, **result.data}

    host = str(merged["host"])
    if not _is_loopback(host):
        raise SystemExit(f"config host must be loopback, got {host!r}")

    workers = int(merged["workers"])
    if workers < 1 or workers > 3:
        raise SystemExit(f"config workers must be in [1, 3], got {workers}")

    cache_dir = Path(str(merged["cache_dir"]))
    if not cache_dir.is_absolute():
        cache_dir = (config_path.parent / cache_dir).resolve()

    backoff = merged["synth_retry_backoff_s"]
    if not isinstance(backoff, list) or not backoff:
        raise SystemExit("config synth.retry_backoff_s must be a non-empty list")

    secret = _valid_secret(merged.get("secret"))
    if secret is None:
        raise SystemExit("config auth.secret is missing or placeholder")

    return Config(
        host=host,
        port=int(merged["port"]),
        secret=secret,
        workers=workers,
        default_voice=str(merged["default_voice"]),
        cache_dir=cache_dir,
        cache_max_bytes=int(merged["cache_max_bytes"]),
        max_text_chars=int(merged["max_text_chars"]),
        request_queue_max=int(merged["request_queue_max"]),
        synth_timeout_s=float(merged["synth_timeout_s"]),
        synth_retries=int(merged["synth_retries"]),
        synth_retry_backoff_s=tuple(float(x) for x in backoff),
        min_audio_bytes=int(merged["min_audio_bytes"]),
        config_path=config_path.resolve(),
        pidfile=pidfile.resolve(),
    )


def read_secret(config_path: Path | None = None) -> str:
    config_path = config_path or default_config_path()
    result = ensure_config(config_path)
    if result.secret_generated:
        kind = "created" if result.created else "injected"
        print_secret_event(kind, result.secret, config_path)
    return result.secret


def print_secret_event(kind: str, secret: str, config_path: Path) -> None:
    if kind == "created":
        msg = f"Generated config at {config_path} (mode 0600) with new secret:"
    else:
        msg = (
            f"auth.secret was missing/invalid in {config_path}; "
            f"wrote a new secret (update the extension):"
        )
    print(f"{msg}\n  {secret}", file=sys.stderr)
