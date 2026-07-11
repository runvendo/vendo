> Historical session record (frozen). Describes the repo at its date; may not match current code.

# Launch README redesign

**Date:** 2026-07-05 · **Branch:** `yousefh409/readme` · **Status:** approved

## Goal

Rework the repo README for launch-day conversion: a developer landing from
HN/X should believe the product is real and know how to try it within 30
seconds. Depth moves to `docs/`.

## Decisions (settled with Yousef)

- Primary job: launch-day conversion, not reference.
- Hero media: real product GIF captured from the Maple demo — the agent
  builds a custom view from a natural-language ask.
- Banner: rebuilt around the new morph-blob mark, light + dark variants
  served via GitHub's `<picture>` / `prefers-color-scheme`.
- Structure: lean launch page; package table folded into `<details>`;
  telemetry reduced to one line in a combined footer.

## Assets (new, in `assets/`)

| Asset | Content |
|---|---|
| `banner-light.svg`, `banner-dark.svg` | Mark + VENDO wordmark + tagline over liquid-glass blobs, ~1280×260. Dark variant on ink background. |
| `hero.gif` | ~10–15 s Maple capture: user asks for a spending view, agent composes generated UI in-brand. Target under ~5 MB. |
| `demo-maple.png` | Static screenshot for the Demos section. |
| Logo SVGs | Copied from the logo worktree (mark not yet in this repo). |

Existing `banner.svg` stays (used as social preview).

## README structure

Banner (picture, light/dark) → badges → one-sentence pitch (current one
kept) → hero GIF → three tightened value bullets → Quickstart
(`npx @vendoai/cli init .`, env key, docs link) → How it works (~4 lines:
acts through the host API as the user; generated UI in an egress-jailed
sandbox; every mutation gated by the host permission policy) → Demos (one
screenshot, both demo apps listed) → `<details>` package table → footer
(docs · telemetry one-liner · contributing · security · license).

## Process & verification

- Work on `yousefh409/readme`; PR to `main` (never commit to `main`).
- Run `pnpm demo`, capture GIF/screenshot in a real browser.
- Verify rendered README visually in light and dark GitHub themes before PR;
  screenshots in the PR per repo rules.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before PR.

## Risks

- GIF capture depends on working demo env keys and agent latency; may take
  several takes. Fallback: high-quality still + video link in the PR.
- GIF size over GitHub-friendly limits → reduce palette/fps/duration, or
  fall back to the still.
