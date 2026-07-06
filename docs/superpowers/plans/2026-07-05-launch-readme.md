# Launch README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the launch-day README: new mark-based banner (light/dark), real Maple hero GIF, lean conversion-focused structure.

**Architecture:** Assets-first — build and verify each visual asset in a browser before wiring it into the README, so the README rewrite lands once against final asset paths. All work on `yousefh409/readme`, PR to `main`.

**Spec:** `docs/superpowers/specs/2026-07-05-launch-readme-design.md`

---

### Task 1: Bring the logo mark into the repo

**Files:** create `assets/vendo-mark.svg`, `assets/vendo-icon.svg`, `assets/vendo-mark-mono.svg` (copied from the logo worktree's `brand-exploration/final/`).

- [x] Copy the three final SVGs into `assets/`
- [x] Confirm each renders correctly (open in browser)
- [x] Commit

### Task 2: Build the banners

**Files:** create `assets/banner-light.svg`, `assets/banner-dark.svg`.

- [x] Compose light banner: mark + VENDO wordmark + tagline over the existing liquid-glass blob treatment, ~1280×260, porcelain background, brand palette (ultramarine #4338CA family)
- [x] Compose dark variant: ink background, blob opacities re-tuned for dark
- [x] Render both in a browser at README width and at mobile width; screenshot-verify legibility (per the verify-UI-visually rule)
- [x] Commit

### Task 3: Capture demo media

**Files:** create `assets/hero.gif`, `assets/demo-maple.png`.

- [x] Start the Maple demo (`pnpm demo`; env per `apps/demo-bank/README.md`)
- [x] In a real browser, ask the agent for a spending-breakdown view; wait for the generated view to render
- [x] Capture `demo-maple.png` — clean framed screenshot of the finished view in Maple
- [x] Record `hero.gif` — the ask → generated view beat, 10–15 s; retake until tight
- [x] Optimize GIF (palette/fps/trim) to under ~5 MB; if not achievable, fall back to a still + PR video link per spec
- [x] Commit

### Task 4: Rewrite the README

**Files:** modify `README.md`.

- [x] Restructure to the approved lean layout: picture-element banner (light/dark) → badges → current pitch sentence → hero GIF → three tightened value bullets → Quickstart → 4-line How-it-works → Demos with screenshot → package table inside `<details>` → footer (docs · telemetry line · contributing · security · license)
- [x] Keep all existing link targets valid (LICENSE, TELEMETRY.md, CONTRIBUTING.md, SECURITY.md, docs/quickstart.md)
- [x] Commit

### Task 5: Verify and open the PR

- [x] Render the final README (GitHub-flavored) in light and dark; screenshot both
- [x] Check every relative link and image path resolves on the branch
- [x] Run `pnpm build && pnpm test && pnpm typecheck && pnpm lint` — all green
- [x] Push branch, open PR to `main` with the light/dark screenshots embedded, per repo rules
