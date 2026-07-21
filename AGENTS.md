# AGENTS

## What this is

**edge-tts-connector** is a local text-to-speech reader for Chromium and Firefox. A browser extension chunks page text and plays audio; a loopback Python daemon synthesizes speech with **edge-tts** (Microsoft online TTS), caches MP3s on disk, and never exposes the extension to the public internet for TTS. The extension talks only to `127.0.0.1`. The daemon is the component allowed to reach the network.

## Doc hierarchy (read in this order)

| File | Role |
|------|------|
| [`.spec/project.md`](.spec/project.md) | Product law: goals, architecture, ownership of knobs, daemon ops, defaults, build order, threats. |
| [`.spec/`](.spec/) | Pre-planning detail that keeps `project.md` thin: wire protocol, reader/session behavior, extension build/runtime. |
| [`.spec/DECISIONS.md`](.spec/DECISIONS.md) | Living log of gaps and deviations (create if missing). |

**Authority**

1. **`.spec/project.md`** — intent and constraints. If something contradicts product goals, change the plan here (or with the user) first.
2. **`.spec/*`** — how to implement that intent (HTTP shapes, messages, chunking, manifests). Prefer following these over inventing parallels.
3. **`.spec/DECISIONS.md`** — what actually happened when the plan was incomplete, wrong in practice, or intentionally overridden.

On conflict: product intent in `.spec/project.md` wins; concrete wire/behavior detail wins in `.spec/*` when intent agrees. Record the resolution in `.spec/DECISIONS.md` by prepending it above the others.

## DECISIONS.md

Use [`.spec/DECISIONS.md`](.spec/DECISIONS.md) whenever implementation is not a straight reading of the plan:

- **Gaps** — unspecified behavior you had to choose (note the choice and why).
- **User-specified deviations** — the user asked to differ from `.spec/project.md` / `.spec/*`; record what changed and update the relevant plan doc when the deviation is lasting.
- **Practical deviations** — the plan was infeasible or bug-prone in situ (API reality, browser limits, etc.); record what you did instead and whether the plan docs should be updated.

Keep entries short, dated, and actionable. Prefer appending; do not silently diverge from the plan without a line here.

## How to work

- Implement **one** [`.spec/project.md` build-order step](.spec/project.md#build-order) per focused session unless the user says otherwise.
- Do not freestyle architecture (transport, cache layout, auth, playback locus).
- After a step: curl/build checks that match the step; note leftovers in `.spec/DECISIONS.md`.
- New lasting behavior belongs in `.spec/project.md` or `.spec/*`, not only in code comments.

## README.md

[`README.md`](README.md) is the maintainer’s voice, not product law and not a second spec.

- **Edit only when facts drift** — wrong commands, paths, status, requirements, or behavior introduced by a code/plan change. Do not rewrite for polish, marketing, or “completeness.”
- **Match the existing voice** — read the file first; keep the same tone, rhythm, and personality (informal, first-person, dry humor where it’s already there). A stranger should not be able to tell an agent touched it.
- **Minimal diffs** — fix the inaccurate bit; leave surrounding prose alone unless a neighboring sentence is now false or contradictory.
- Prefer putting durable how-to detail in `.spec/` / script output; the README stays a short human front door.
