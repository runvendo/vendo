# Unified Try Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One playground surface served from two venues — `npx vendo try` (local, zero-commit, real repo profile) and vendo.run (hosted, domain-paste, context.dev-seeded) — replacing both existing playgrounds, with AI-suggested use-case chips in both venues.

**Spec:** `/tmp/unified-try-surface-spec.md` (approved 2026-07-23). Addendum from review: AI-generated use-case chips the user can press, both venues. Hosted "cheat" mechanism (pre-generation/templates/caching) explicitly **deferred** — v1 chips run live.

**Repos:** vendo OSS (this worktree, branch `yousefh409/unified-try-surface`) + vendo-web (tandem rule — same wave). vendo-web work happens in a fresh worktree off `main`; the existing checkout is on an unrelated branch.

---

## Architecture decisions (implementer calls within the locked spec)

1. **No new package for the shared surface.** The surface app stays in `@vendoai/vendo` (`src/cli/playground/app/` evolves into the try surface). Precedent: the bundle is already built by Vite into an embedded JS string (`build-playground.mjs`) and vendo-web already consumes it as a vendored compiled artifact (`public/playground/playground.js`). One source, one bundle, three consumers (try command, vendo.run page, docs embed). A new package would force a dependency-guard layer edit for zero benefit.
2. **Profile = one aggregate JSON + an event stream.** The surface boots from a single `/profile.json` (theme, brand, brief, tool/catalog summary, use-case chips, synthetic fixtures, depth status) and subscribes to a server-sent-events channel that announces deepening (each AI extraction stage landing). Same shape both venues, filled to different depths — the spec's "one profile schema, two depths" made concrete.
3. **Synthetic data rides the existing injectable-fetch seam.** The actions registry already accepts a custom `fetch` (`RegistryConfig.fetch`). A synthetic executor answers route-tool calls from an AI-generated fixtures artifact instead of the host's (not-running) API. `createVendo` gains two small config passthroughs it's missing: profile directory (currently hardcoded to cwd) and fetch. This is what lets both venues generate *real* apps on synthetic data with zero host involvement.
4. **New "seeds" AI pass** (staged-extraction style): generates the use-case chips and the synthetic entity fixtures from the brief + tool list (local) or the company description alone (hosted). Runs behind the first paint, streams in.
5. **Live chat when a model is reachable, scripted when not.** `vendo try` mounts a real `createVendo` handler in its own server (BYO key / provider env / `VENDO_API_KEY` ladder — existing resolution, no new key logic). Zero-key: the surface still paints with their real theme + tool catalog and chips fall back to scripted director-mode turns, with a nudge to add a key. Hosted: chat goes through a new rate-limited console route to the existing LiteLLM gateway.
6. **Conversational refine is the local venue's feature.** `runRefine` needs a repo; the try server exposes it as an endpoint, corrections typed in chat become reviewable diff cards, approval writes to the *temp* profile (never the repo). Hosted venue gets no refine in v1 (no repo to refine against); brand-tweak corrections hosted-side are a follow-up.
7. **Shareable link v1 = domain in the URL** (`vendo.run/playground?d=acme.com` re-runs the flow deterministically for anyone). Cached/persisted shares belong to the deferred cheat decision.
8. **Retirement:** `vendo playground` command is removed and `vendo try` absorbs it (try outside a repo, or zero-key, serves the scripted scenarios). The docs-embed entry (`embed.js`, `VendoDocsEmbed`) is preserved unchanged — Mintlify docs depend on it.

## Not in this wave

Hosted cheat stack (speculation/templates/domain-cache) · web→local profile handoff (spec: nice-to-have) · hosted refine · init/doctor/install changes · multi-view apps.

---

## Phase 1 — Profile plumbing (OSS)

### Task 1: TryProfile schema + assembler
**Files:** create `packages/vendo/src/cli/try/profile.ts` (+ test)
- [ ] Define the profile contract: brand (name, logo, domain), theme (`VendoTheme`), brief, tools summary (names/descriptions/risk, counts), component catalog summary, use-case chips, synthetic fixtures ref, and a `depth` block (`shallow | deepening | deep` + per-stage status).
- [ ] Assembler reads an existing `.vendo` directory (any root — repo or temp) into that shape; missing files degrade to shallow, never throw.
- [ ] Tests: assemble from the committed demo-bank profile; assemble from an empty dir.

### Task 2: Zero-commit deterministic pass
**Files:** create `packages/vendo/src/cli/try/extract.ts` (+ test)
- [ ] Run the existing deterministic extractors (`extractTheme`, `vendoSync`) with output pointed at a per-run temp dir; assert nothing is written under the target repo (this is the zero-commit guarantee, tested explicitly).
- [ ] Measure-and-report: the pass finishes before the server opens the browser (latency law).

### Task 3: "Seeds" AI pass — use-case chips + synthetic fixtures
**Files:** create `packages/vendo/src/cli/extract/seeds.ts` (+ test); touch `extract/stages.ts` only if reuse demands it
- [ ] One harness pass (same `ExtractionHarness` pattern as stages.ts, zod-validated artifact) producing `usecases.json` (4–6 product-specific chip prompts) and `fixtures.json` (plausible entity rows keyed to the extracted routes).
- [ ] Degrades gracefully: failure yields generic chips + empty fixtures, never blocks the surface.
- [ ] Tests with a scripted harness stub (init.test.ts pattern).

## Phase 2 — `vendo try` command (OSS)

### Task 4: createVendo seams — profile dir + fetch
**Files:** modify `packages/vendo/src/server.ts` (+ test)
- [ ] Add explicit config passthroughs for the profile directory (today hardcoded `dir: "."`) and the actions fetch (registry already supports it). Documented adapter-rule-clean options, no key-conditional behavior.
- [ ] Synthetic fetch implementation: answers route-tool requests from `fixtures.json`; unknown routes return an honest empty-shape response. Lives in `cli/try/synthetic-fetch.ts` (+ test).

### Task 5: Try server
**Files:** create `packages/vendo/src/cli/try/server.ts` (+ test), pattern-copied from `cli/playground.ts`
- [ ] Serves the surface bundle, `/profile.json`, `/events` (SSE), and mounts the real `createVendo` handler at `/api/vendo/*` with temp profile dir + synthetic fetch + existing model ladder.
- [ ] Advertises capability flags in the profile (live chat available? refine available?) so the surface picks live vs scripted honestly.
- [ ] Tests: in-process server, fetch assertions (playground.test.ts pattern).

### Task 6: Background deepening orchestration
**Files:** create `packages/vendo/src/cli/try/deepen.ts` (+ test)
- [ ] After first paint: run `runAiExtraction` (existing engine ladder, consent-free here — try is explicitly an AI-driven demo, flag `--no-ai` opts out) with output to the temp dir, then the seeds pass; emit an SSE event per artifact landing; profile endpoint always reflects current depth.
- [ ] Zero-credential environments skip silently to scripted mode (existing self-skip behavior).

### Task 7: CLI wiring
**Files:** modify `packages/vendo/src/cli.ts`; create `packages/vendo/src/cli/try.ts` (+ test)
- [ ] `vendo try` with `--port`, `--no-open`, `--engine`, `--no-ai`; bespoke loud-fail flag validation (house pattern); telemetry via `withCommandRun`; HELP text.
- [ ] Exit line suggests `npx vendo init` to keep it.
- [ ] Outside a repo / nothing extractable: serves the scripted scenario set (absorbing `vendo playground`'s job) instead of erroring.

## Phase 3 — Surface app (OSS)

### Task 8: Profile-driven boot
**Files:** modify `packages/vendo/src/cli/playground/app/` (main entry + new `profile-boot.ts`)
- [ ] Fetch `/profile.json` before first render when served by try/hosted config; apply theme via the existing CSS-var mechanism; brand header (logo + name); subtle depth indicator ("learning your codebase…" while deepening) that never blocks input.
- [ ] SSE subscription updates chips/brief/catalog live as stages land.

### Task 9: Use-case chips
**Files:** new component under `playground/app/`
- [ ] Chips rendered above the composer; press → existing `autoSend` seam fires the prompt into the real composer; chips refresh when the seeds artifact lands.

### Task 10: Live venue mode
**Files:** `playground/app/scenario-mount.tsx` and siblings
- [ ] When the profile advertises live chat: real transport against `/api/vendo` (the code path already exists in the bundle — today unused on vendo.run); otherwise ScriptedTransport (today's behavior).

### Task 11: Refine chat (local venue)
**Files:** try server endpoint + new surface review-card component
- [ ] Try server endpoint wraps `runRefine` (interview = the user's chat message; model from the same ladder); response = proposed diffs.
- [ ] Surface renders diff review cards with approve/dismiss; approve applies to the temp profile and the session picks up the change; a note explains `vendo init` + `vendo refine` persist this for real.
- [ ] Decide `vendo refine` CLI fate: **keep** (it serves the post-init flow; no fold needed this wave).

### Task 12: Visual verification
- [ ] Real-browser screenshots of: instant paint on a test repo, chips, deepening indicator, live generation, refine diff card, zero-key scripted fallback. (Playwright against the local server; screenshots into the PR.)

## Phase 4 — Hosted venue (vendo-web, tandem)

### Task 13: vendo-web worktree + branch off main.

### Task 14: Console API — try profile route
**Files:** new route under `apps/console/app/api/v1/try/`
- [ ] Domain in → context.dev `POST /brand/retrieve` (server-side, `CONTEXT_DEV_API_KEY` secret; paid API stays web-side per spec) → map colors/logo/fonts/description onto the same TryProfile shape (shallow depth). Existing per-IP throttle pattern applied.

### Task 15: Console API — hosted seeds + chat
**Files:** new routes under `apps/console/app/api/v1/try/`
- [ ] Seeds route: chips + synthetic tool catalog + fixtures generated from the company description via the existing gateway model (this is the hosted stand-in for repo extraction — same artifact shapes).
- [ ] Chat route: agent loop for the try venue through the LiteLLM gateway, wearing the existing org-rate-limit/quota/spend-cap middlewares with an anonymous-tier policy; fresh `@vendoai/*` tarballs vendored (console's are 0.3.0-stale).

### Task 16: vendo.run page
**Files:** vendo-web root `app/` + `public/playground/`
- [ ] Replace the playground page: domain-paste hero → calls console try routes → boots the same surface bundle (venue=hosted config, API base = console). `?d=<domain>` share links replay the flow. Fresh bundle vendored from this wave's OSS build; `embed.js` kept.
- [ ] Real-browser verification: paste a known domain, watch re-theme + chips + a live generation; screenshots for the PR.

## Phase 5 — Retirement, docs, gates

### Task 17: Retire `vendo playground`
- [ ] Remove the command from `cli.ts` + HELP (error message points to `vendo try`); keep the embed bundle build + entry; migrate internal references/tests.

### Task 18: Docs sync
- [ ] `docs/` + `docs-site/`: try quickstart page, playground references → try, hosted playground docs updated. Succinct, per house style.

### Task 19: Gates + PRs
- [ ] OSS: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green; PR with screenshots.
- [ ] vendo-web: console + root builds green, deploy previews verified in browser; PR with screenshots. Both PRs cross-linked, land as one wave.

---

## Verification strategy
- Every OSS task: vitest in-process with injected seams (output sink, harness stub, ports, fetch) — the established house pattern; TDD per task.
- Zero-commit guarantee has a dedicated test (repo tree hash unchanged after a full try run).
- Latency law verified with a wall-clock assertion in the try server test (first paint served before any AI work starts) and by browser observation.
- End-to-end: live run against a real test repo from `~/vendo-test-repos` before the PR.

## Risks
- **Hosted chat route is the biggest net-new surface** (public + real model): mitigated by existing throttle/quota/spend-cap middlewares and the WAF note already on file; anonymous tier gets tight caps.
- **Synthetic fetch fidelity:** generated apps are only as convincing as fixtures; seeds pass quality gets iterated with the eval habit, not gated on.
- **Console vendored-tarball refresh** may surface 0.3.0→0.4.x API drift; scoped to the new try routes.
