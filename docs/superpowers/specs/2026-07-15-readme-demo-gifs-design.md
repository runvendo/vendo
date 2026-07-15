# README demo GIFs, recaptured

Date: 2026-07-15. Owner: Yousef. Branch: `yousefh409/demo-readme`.

## Problem

The launch README's demo GIFs (hero, remix, automation, voice, init) were
removed in commit `888abe2f` during the contracts-first docs rewrite because
they showed the pre-v0 product. The current README has no visual proof of the
product. Decision: recapture against the current product with the merged
demo-capture harness (PR #195), not restore the stale GIFs.

## Scope

Three GIFs, captured live with `pnpm --filter @vendoai/bench demo:capture`:

1. `streaming-first-paint` on Maple (demo-bank). The hero beat: a customer
   asks a question and a live view composes.
2. `remix-edit` on Cadence (demo-accounting). Generation plus edit
   continuity, and shows the second brand.
3. `host-component` on Maple. A generated app composing real host components.

Out of scope: corpus montage (needs a separate multi-repo gallery run), voice
and automation beats (no harness support; rigs would need rebuilding), init
terminal GIF, any other README restructuring.

## Treatment

The harness records real time with a stopwatch overlay burned in, and current
generation speed is roughly 123s to first paint. Raw GIFs are unusable for
marketing. Post-process each recording with ffmpeg: segments cut at the
recorded `capture.json` marks (submit, first paint, usable), action at 1x,
waits at roughly 6x, then palettegen/paletteuse (max 160 colors, bayer
dither). Target at most 3 MB per GIF. The stopwatch stays visible and
fast-ticks during sped segments; this is the honest version of the speed-up.
The post-processing script lives in the session scratchpad, not the repo.

## README change

One new "See it in action" section directly after the install code block,
using the launch README v2 layout: a 2+1 equal-width table grid (two GIFs in
the first row, one centered single-cell second row, no empty td). Descriptive
alt text per GIF. GIFs committed under `assets/`. Nothing else in the README
moves. Zero em dashes.

## Verification

- Watch each GIF end to end; check first-paint moment, legibility, loop.
- Confirm the README renders correctly with the grid (branch preview).
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.
- PR from `yousefh409/demo-readme`, reviewed by Yousef before merge.

## Constraints

- Keys sourced from `/Users/yousefh/orca/workspaces/flowlet/.env` into the
  shell only; never printed or committed.
- Live generation costs real API dollars until sub caps reset Jul 18-19;
  three beats plus retakes is the budget, no exploratory runs.
- Repo `.gitignore` history: confirm `assets/*.gif` is not ignored before
  committing.
