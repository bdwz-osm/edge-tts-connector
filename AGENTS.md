# AGENTS

## What this is

**edge-tts-connector** is a local text-to-speech reader for Chromium and Firefox. A browser extension chunks page text and plays audio; a loopback Python daemon synthesizes speech with **edge-tts** (Microsoft online TTS), caches MP3s on disk, and never exposes the extension to the public internet for TTS. The extension talks only to `127.0.0.1`. The daemon is the component allowed to reach the network.

## Doc hierarchy (read in this order)

| File | Role |
|------|------|
| [`project.md`](project.md) | Product law: goals, architecture, ownership of knobs, daemon ops, defaults, build order, threats. |
| [`.spec/`](.spec/) | Pre-planning detail that keeps `project.md` thin: wire protocol, reader/session behavior, extension build/runtime. |
| [`DECISIONS.md`](DECISIONS.md) | Living log of gaps and deviations (create if missing). |

**Authority**

1. **`project.md`** — intent and constraints. If something contradicts product goals, change the plan here (or with the user) first.
2. **`.spec/*`** — how to implement that intent (HTTP shapes, messages, chunking, manifests). Prefer following these over inventing parallels.
3. **`DECISIONS.md`** — what actually happened when the plan was incomplete, wrong in practice, or intentionally overridden.

On conflict: product intent in `project.md` wins; concrete wire/behavior detail wins in `.spec/*` when intent agrees. Record the resolution in `DECISIONS.md`.

## DECISIONS.md

Use this file whenever implementation is not a straight reading of the plan:

- **Gaps** — unspecified behavior you had to choose (note the choice and why).
- **User-specified deviations** — the user asked to differ from `project.md` / `.spec/`; record what changed and update the relevant plan doc when the deviation is lasting.
- **Practical deviations** — the plan was infeasible or bug-prone in situ (API reality, browser limits, etc.); record what you did instead and whether the plan docs should be updated.

Keep entries short, dated, and actionable. Prefer appending; do not silently diverge from the plan without a line here.

## How to work

- Implement **one** [`project.md` build-order step](project.md#build-order) per focused session unless the user says otherwise.
- Do not freestyle architecture (transport, cache layout, auth, playback locus).
- After a step: curl/build checks that match the step; note leftovers in `DECISIONS.md`.
- New lasting behavior belongs in `project.md` or `.spec/`, not only in code comments.
