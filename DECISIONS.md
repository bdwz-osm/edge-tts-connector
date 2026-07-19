# DECISIONS

## 2026-07-18 — Daemon v1 (build-order step 1)

- **Logging:** `run.sh start` redirects daemon stdout/stderr to `daemon/daemon.log` (gitignored). Not specified in plan; needed for crash diagnosis.
- **Queue depth:** `request_queue_max` counts distinct in-flight synth keys (after cache miss / coalesce), not raw HTTP connections. Coalesced waiters share one slot.
- **Pitch:** accept any `±NHz` matching the wire form; default `+0Hz`. Extension is expected to send `+0Hz` in v1.
- **Python without uv:** allow system `python3` with major.minor ≥ pin from `DEPENDENCIES.sh` (not only exact pin).
- **Error `attempts`:** included on synth error JSON whenever a `SynthError` is raised (including validation); harmless extra field vs rpc.md examples.
- **OPTIONS:** handled entirely in CORS middleware (no separate router entry).

## 2026-07-18 — Config TOML + ops UX

- **TOML over JSON:** sectioned `config.toml`; stdlib `tomllib` (3.11+). Plan docs updated.
- **No config.example.toml:** first start writes a full template (active `auth.secret`, other knobs commented by section).
- **OPTIONS schema:** `config.py` `OPTIONS` tuple is the single source for defaults, TOML paths, and generated `config.toml`; only the file header prose is fixed.
- **Secret repair:** if `config.toml` exists but `auth.secret` is missing/invalid/placeholder, inject a new secret under `[auth]` and warn (extension must be updated).
- **Config location:** repo-root `config.toml` (not under `daemon/`).
- **Sections:** `[auth]`, `[server]`, `[synth]`, `[cache]` with short keys (`timeout_s`, `retries`, `dir`, …) mapped to internal names in `config.py`.
- **venv path:** `daemon/venv` (not `.venv`).
- **Wrapper:** repo-root `server.sh` forwards to `daemon/run.sh`.
- **start output:** always prints secret + URL/pid/log paths so the extension can be configured without opening the file.
