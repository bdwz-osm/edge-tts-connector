from __future__ import annotations

from pathlib import Path

import pytest

from config import (
    VALID_RATES,
    ensure_config,
    flatten_toml,
    inject_secret,
    load_config,
    render_full_config,
    _is_loopback,
    _valid_secret,
)


def test_valid_rates_span() -> None:
    assert VALID_RATES[0] == "-50%"
    assert VALID_RATES[-1] == "+100%"
    assert "+0%" in VALID_RATES
    assert all(r.endswith("%") for r in VALID_RATES)
    # step 10
    nums = [int(r[:-1]) for r in VALID_RATES]
    assert nums == list(range(-50, 101, 10))


@pytest.mark.parametrize(
    "host,ok",
    [
        ("127.0.0.1", True),
        ("::1", True),
        ("0.0.0.0", False),
        ("8.8.8.8", False),
        ("not-a-real-host.invalid", False),
    ],
)
def test_is_loopback(host: str, ok: bool) -> None:
    assert _is_loopback(host) is ok


@pytest.mark.parametrize(
    "value,ok",
    [
        ("abc", True),
        ("  secret  ", True),
        ("", False),
        ("   ", False),
        ("<generated>", False),
        (None, False),
        (123, False),
    ],
)
def test_valid_secret(value: object, ok: bool) -> None:
    got = _valid_secret(value)
    if ok:
        assert got is not None
        assert got == str(value).strip()
    else:
        assert got is None


def test_flatten_sectioned_and_legacy() -> None:
    flat = flatten_toml(
        {
            "auth": {"secret": "s"},
            "server": {"host": "127.0.0.1", "port": 24765},
            "synth": {"workers": 2},
            "cache": {"dir": "tts-cache", "max_bytes": 100},
            "unknown_section": {"x": 1},
        }
    )
    assert flat["secret"] == "s"
    assert flat["host"] == "127.0.0.1"
    assert flat["port"] == 24765
    assert flat["workers"] == 2
    assert flat["cache_dir"] == "tts-cache"
    assert flat["cache_max_bytes"] == 100
    assert "x" not in flat

    legacy = flatten_toml({"secret": "legacy", "workers": 1})
    assert legacy == {"secret": "legacy", "workers": 1}


def test_render_full_config_has_secret_and_commented_defaults() -> None:
    text = render_full_config("my-secret")
    assert 'secret = "my-secret"' in text
    assert "[auth]" in text
    assert "[server]" in text
    assert "# workers = 2" in text
    assert "# host = " in text


def test_inject_secret_replaces_existing() -> None:
    src = '[auth]\nsecret = "old"\n\n[server]\n# host = "127.0.0.1"\n'
    out = inject_secret(src, "new")
    assert 'secret = "new"' in out
    assert "old" not in out
    assert "[server]" in out


def test_inject_secret_under_auth_header() -> None:
    src = "[auth]\n\n[server]\n"
    out = inject_secret(src, "injected")
    assert 'secret = "injected"' in out
    assert out.index("[auth]") < out.index("secret") < out.index("[server]")


def test_inject_secret_prepends_auth_block() -> None:
    src = "[server]\n# port = 1\n"
    out = inject_secret(src, "prepended")
    assert out.startswith("[auth]\n")
    assert 'secret = "prepended"' in out


def test_ensure_config_creates(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    result = ensure_config(path)
    assert result.created is True
    assert result.secret_generated is True
    assert path.is_file()
    assert result.secret
    assert 'secret = "' in path.read_text(encoding="utf-8")


def test_ensure_config_keeps_valid_secret(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text('[auth]\nsecret = "keep-me"\n', encoding="utf-8")
    result = ensure_config(path)
    assert result.created is False
    assert result.secret_generated is False
    assert result.secret == "keep-me"


def test_ensure_config_injects_missing_secret(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text("[auth]\n# secret missing\n[server]\n", encoding="utf-8")
    result = ensure_config(path)
    assert result.secret_generated is True
    text = path.read_text(encoding="utf-8")
    assert result.secret in text
    assert "[server]" in text


def test_load_config_defaults_and_relative_cache(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text('[auth]\nsecret = "s"\n', encoding="utf-8")
    cfg = load_config(path, pidfile=tmp_path / "x.pid")
    assert cfg.host == "127.0.0.1"
    assert cfg.port == 24765
    assert cfg.workers == 2
    assert cfg.secret == "s"
    assert cfg.cache_dir == (tmp_path / "tts-cache").resolve()
    assert cfg.synth_retry_backoff_s == (0.5, 1.5, 3.0)


def test_load_config_rejects_non_loopback(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text(
        '[auth]\nsecret = "s"\n[server]\nhost = "8.8.8.8"\n',
        encoding="utf-8",
    )
    with pytest.raises(SystemExit, match="loopback"):
        load_config(path, pidfile=tmp_path / "x.pid")


def test_load_config_rejects_workers_out_of_range(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text(
        '[auth]\nsecret = "s"\n[synth]\nworkers = 4\n',
        encoding="utf-8",
    )
    with pytest.raises(SystemExit, match="workers"):
        load_config(path, pidfile=tmp_path / "x.pid")


def test_load_config_rejects_empty_backoff(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text(
        '[auth]\nsecret = "s"\n[synth]\nretry_backoff_s = []\n',
        encoding="utf-8",
    )
    with pytest.raises(SystemExit, match="retry_backoff_s"):
        load_config(path, pidfile=tmp_path / "x.pid")
