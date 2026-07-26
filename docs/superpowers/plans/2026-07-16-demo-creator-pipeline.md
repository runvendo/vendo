# Demo Creator Pipeline (Milestone 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Milestone 2 of the demo-creator spec: the creator pipeline as repo tooling + playbook, proven end-to-end by generating and verifying three demos of real popular products (Linear, Stripe, Shopify).

**Architecture:** The mechanical stages become CLI tooling inside `@vendoai/bench` (which already owns the capture harness, Playwright, vitest, and CI wiring): `demo-creator/create` clones and re-identifies the template, `demo-creator/research` captures a prospect URL's brand evidence, and verification stays `demo-capture demo-beats`. The creative stage (rewriting the visible product) is an agent session following a checked-in playbook that binds it to `apps/demo-template/VERIFY.md`. Generated demos are untracked scratch under `apps/` for now (the separate `runvendo/demos` repo and deploy flow are milestone 3).

**Per Yousef's planning rules this plan is high-level: goals, steps, decisions, exact paths — no code.**

---

## Decisions

- Tooling lives in `bench/src/demo-creator/` (reuses bench's build/test/typecheck/playwright; no new package, no new CI wiring).
- Research is evidence-gathering, not automated extraction: full-page + viewport screenshots, page title, meta theme-color, favicon, and a best-effort computed-style palette dump into `research.json`. The creator agent does the judging; no brittle "theme extractor for arbitrary sites" in this milestone.
- Generated demos: `apps/demo-<id>`, untracked, linked via `pnpm install` during a session; `pnpm-lock.yaml` reverted afterwards so the tracked tree stays clean.
- Test prospects: Linear (issue tracking), Stripe (payments), Shopify (commerce admin) — three recognizable brands, three distinct domains and palettes.
- Privacy/brand rule carried from the dry-run design: seed data is invented; prospect branding is used only inside the clearly-watermarked demo.

## File map

**Create (bench/):**
- `bench/src/demo-creator/create.ts` + `create.test.ts` — clone `apps/demo-template` → target app dir (exclude `.vendo/data`, `node_modules`, `.next`), rename package, write a `demo.config.json` skeleton from CLI args (id, prospect, ctaUrl), leave a `RESEARCH/` pointer
- `bench/src/demo-creator/research.ts` + `research.test.ts` — Playwright capture of a prospect URL: screenshots, title/theme-color/favicon, computed-style palette sample → `<appDir>/RESEARCH/research.json` + images
- `bench/src/demo-creator/cli.ts` — `demo:create` / `demo:research` script entries in bench package.json
- `bench/demo-creator/PLAYBOOK.md` — the creator-agent contract: stage order (research → clone → rewrite visible product → entity/actions/openapi → beats+chips → verify via demo-beats → brand-fidelity self-score → uncanny-data pass → cleanup), fences recap, 3-strikes rule, output manifest

**No changes to:** `apps/demo-template` (frozen contract for this milestone), `bench/src/demo-capture/` (verification is already built).

## Task 1: `demo:create` scaffolding CLI (TDD)

- [ ] Failing tests: clone excludes junk dirs, package.json renamed, demo.config skeleton written with args, refuses to overwrite an existing target, refuses ids that don't match the schema slug
- [ ] Implement; wire `demo:create` script; green: bench test/typecheck + a real run creating and deleting a scratch app
- [ ] Commit

## Task 2: `demo:research` capture (TDD for pure parts)

- [ ] Failing tests for the pure logic (palette aggregation from sampled styles, research.json shape)
- [ ] Implement Playwright capture (viewport + full-page screenshots, title, meta theme-color, favicon URL, sampled computed styles of body/header/buttons/links)
- [ ] Prove on one real site; green gates; commit

## Task 3: PLAYBOOK.md

- [ ] Write the creator-agent playbook binding create → research → rewrite → verify, referencing real commands and `apps/demo-template/VERIFY.md`; include the brand-fidelity scoring rubric (palette/type/layout/tone, 1–5, harsh) and the invented-data rule
- [ ] Review pass (spec + quality) across Tasks 1–3; commit

## Task 4: Generate + verify the three test demos

- [ ] For each of Linear, Stripe, Shopify: creator-agent session follows PLAYBOOK.md end-to-end (research the real site, build `apps/demo-linear|stripe|shopify`, demo-beats capture green with declared expectations, fidelity self-score, static screenshots)
- [ ] Builds may run in parallel; `pnpm install` and captures serialized (ports 3200/3300/3400)
- [ ] Each demo's result bundle: GIF, capture.json timings, inbox/panel screenshots, fidelity scores, frictions list

## Task 5: Results + cleanup

- [ ] Results summary (per-demo timings, expectation outcomes, fidelity scores, artifact paths) for Yousef
- [ ] Tracked tree clean (`pnpm-lock.yaml` reverted, demos untracked); pipeline commits pushed to the PR branch
- [ ] Milestone-2 learnings appended to the project memory (frictions the milestone-3 automation must fix)
