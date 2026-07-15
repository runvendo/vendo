# README Demo GIFs Implementation Plan

> **For agentic workers:** Execute with superpowers:executing-plans, task by task.
> Spec: `docs/superpowers/specs/2026-07-15-readme-demo-gifs-design.md`

**Goal:** Recapture three demo GIFs against the current product and restore a
"See it in action" grid to the README.

**Approach:** Use the merged demo-capture harness for real recordings, speed up
the waits in post, commit the GIFs to `assets/`, and add one README section.
No product code changes.

---

### Task 1: Preflight

- [ ] Confirm `assets/*.gif` is not gitignored.
- [ ] `pnpm install` and `pnpm build` at the repo root.
- [ ] Ensure Playwright Chromium is installed for `@vendoai/bench`.
- [ ] Confirm `ffmpeg` and `ffprobe` are on PATH (montage-grade build not needed).
- [ ] Source the shared keys from the workspaces-root `.env` into the shell
      without printing them; confirm `ANTHROPIC_API_KEY` is set (presence only).

### Task 2: Capture the three beats

One live run each, distinct run ids, sequential (the harness locks port 3000):

- [ ] `streaming-first-paint` on Maple, run id `readme-hero`.
- [ ] `remix-edit` on Cadence, run id `readme-remix`.
- [ ] `host-component` on Maple, run id `readme-host`.
- [ ] After each run, sanity-check the output dir: raw video, `capture.json`
      with marks, converted GIF, and skim `server.log` for errors.
- [ ] Budget: one retake per beat at most. If a beat fails twice, stop and
      report rather than burning API spend.

### Task 3: Post-process to README-grade GIFs

- [ ] Write a scratch script (outside the repo) that reads each run's
      `capture.json` marks and re-cuts the raw video: action segments at 1x,
      wait segments at roughly 6x, then the palette-based GIF conversion.
- [ ] Target at most 3 MB per GIF; drop fps or width if needed.
- [ ] Copy the finished GIFs to `assets/hero.gif`, `assets/remix.gif`,
      `assets/host-component.gif`.

### Task 4: Verify the GIFs visually

- [ ] Watch each GIF end to end (frame extraction or browser preview):
      submit visible, first paint lands, final state legible, loop clean,
      stopwatch behavior acceptable.
- [ ] Check brand fidelity: Maple beats look like Maple, Cadence like Cadence.

### Task 5: README section

- [ ] Add "See it in action" directly after the install code block: 2+1
      equal-width table grid (hero + remix top row, host-component centered
      in a single-cell second row), descriptive alt text, zero em dashes.
- [ ] Preview the rendered README (branch view or local renderer) and
      screenshot the grid.

### Task 6: Green checks and PR

- [ ] `pnpm build && pnpm test && pnpm typecheck && pnpm lint` all green.
- [ ] Commit GIFs + README, push, open PR to `main` with the grid screenshot
      and capture details in the description.
