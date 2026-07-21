# PostHog Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship console session recordings + full analytics, docs analytics, and two-lane CLI telemetry enrichment, live-verified in PostHog before the 2026-07-22 launch.

**Architecture:** Three independent workstreams. Console (vendo-web) mounts posthog-js behind a first-party `/ingest` proxy with recordings and identity. Docs is a one-block Mintlify config change. CLI (this repo) extends the existing `vendo-telemetry` allowlist machinery with richer anonymous properties and a cloud lane keyed off `VENDO_API_KEY`. A live E2E gate against the real PostHog project closes each workstream.

**Tech Stack:** posthog-js, Next.js rewrites on OpenNext/Cloudflare, Mintlify `docs.json`, existing `@vendoai/telemetry` package.

**Spec:** `docs/superpowers/specs/2026-07-21-posthog-analytics-design.md` (all decisions locked there; this plan adds no new policy).

**Per-repo rules:** never commit to main; PRs need `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green; UI changes need real-browser screenshots in the PR.

---

## Workstream A — Console (vendo-web repo, new branch off main)

### Task A1: PostHog provider

**Files:** create `apps/console/components/PostHogProvider.tsx`; modify `apps/console/app/layout.tsx`; modify `apps/console/package.json` (add posthog-js).

- [ ] Add posthog-js dependency.
- [ ] Write a failing component test (new `apps/console/tests/analytics.test.tsx`, modeled on the repo-root `tests/analytics.test.tsx`) covering: init happens once with the expected config (proxy api_host, autocapture on, recordings on with all inputs masked, `surface: "console"` super property), and no-ops cleanly if the key is absent.
- [ ] Implement the provider: baked default project key constant (same write-only key as `vendo-telemetry`) with `NEXT_PUBLIC_POSTHOG_KEY` env override; `api_host` = `/ingest`; posthog-js history-change pageview defaults; mount in the root layout so login and signed-in routes are both covered.
- [ ] Tests green; commit.

### Task A2: First-party ingestion proxy

**Files:** modify `apps/console/next.config.ts`.

- [ ] Add rewrites mapping `/ingest/*` to PostHog US ingestion and `/ingest/static/*` to PostHog's assets host (recorder script), per PostHog's reverse-proxy docs for Next.js.
- [ ] Verify locally that a dev-server pageview produces a 200 through `/ingest` (network tab), not a direct posthog.com call.
- [ ] Commit.

### Task A3: Identity lifecycle

**Files:** modify `apps/console/app/(console)/layout.tsx` (already has `user.email`); small client component for identify; modify the nav/link that points at `app/auth/signout/route.ts` to reset client state before navigating.

- [ ] Identify by email on signed-in layout mount (idempotent across navigations).
- [ ] Reset PostHog identity on sign-out click (signout is a server route, so reset fires client-side before navigation).
- [ ] Test: identify called with the session email; reset called on sign-out. Commit.

### Task A4: Activation events

**Files:** modify `apps/console/app/(auth)/login/page.tsx` (or its client child) for login-completed; `apps/console/app/(console)/keys/KeysClient.tsx` for key-created; `apps/console/app/(console)/billing/PlanSwitchConfirm.tsx` for plan-changed; the claim flow under `apps/console/app/claim/` for deployment-claimed.

- [ ] Fire exactly four manual events client-side on success paths: `console_login_completed`, `api_key_created`, `plan_changed`, `deployment_claimed`. Autocapture covers everything else.
- [ ] Tests for each event trigger. Commit.

### Task A5: Recording privacy

**Files:** modify `apps/console/app/(console)/keys/KeysClient.tsx` and any component that renders claim/invite tokens.

- [ ] Add `ph-no-capture` to key-reveal and token-bearing elements so secrets never enter recordings (inputs are already masked globally by A1's config).
- [ ] Grep the console for other secret-rendering spots (key mint result, OTP display) and cover them too. Commit.

### Task A6: Console PR

- [ ] `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.
- [ ] Real-browser walkthrough of login → keys → billing with screenshots.
- [ ] Open PR; deploy via the existing staging workflow (`.github/workflows/console-staging.yml`) for the live gate (Workstream D).

## Workstream B — Docs (this repo, rides the CLI branch)

### Task B1: Mintlify PostHog block

**Files:** modify `docs-site/docs.json`.

- [ ] Add the `integrations.posthog` block with the shared project key and session recording enabled (Mintlify proxies ingestion itself; no other config).
- [ ] Commit. Verification happens post-merge in Workstream D.

## Workstream C — CLI telemetry (this repo, this branch)

### Task C1: New base properties

**Files:** modify `packages/vendo-telemetry/src/base-props.ts` + its test; `TELEMETRY.md` table row.

- [ ] TDD: `projectIdHash` (constant-salted SHA-256 of git remote origin URL, fallback package.json name, omitted when neither exists) and `packageManager` (npm/pnpm/yarn/bun from the npm user-agent env; omitted when unknown).
- [ ] Commit.

### Task C2: Cloud lane in the client

**Files:** modify `packages/vendo-telemetry/src/client.ts` + `client.test.ts`; `packages/vendo-telemetry/src/events.ts` + `events.test.ts`.

- [ ] TDD: when `VENDO_API_KEY` is present and well-formed (`vnd_` + 40 hex), events gain `cloud: true` and `cloudKeyHash` (SHA-256 of the key) and cloud-only allowlist keys become permitted; without the key, cloud-only keys are stripped even if callers pass them. The consent gates are unchanged and still run first.
- [ ] Define the cloud-only key set in `events.ts` alongside the existing allowlist: `projectName`, `errorDetail`, per-stage init timings, config-surface counts, `repoHost`.
- [ ] Commit.

### Task C3: Error scrubber

**Files:** create `packages/vendo-telemetry/src/scrub.ts` + test.

- [ ] TDD: truncate to ~200 chars and redact absolute/relative file paths, emails, and key/secret-shaped substrings (`vnd_`, `phc_`, `sk-`, hex/base64 runs). Used only for the cloud-lane `errorDetail`.
- [ ] Commit.

### Task C4: Event allowlist enrichment

**Files:** modify `packages/vendo-telemetry/src/events.ts` + test; `TELEMETRY.md`.

- [ ] Extend `init_completed` with: `typescript`, `router`, `engine`, `apiDetectMethod`, `routeCount`, `themeExtracted`, `frameworkVersion`, `reactVersion`, `zodVersion`, `typescriptVersion`.
- [ ] Add `extract_completed` (framework, method, route/tool counts, ok, duration, version props) and `command_run` (closed command enum: extract, theme, eject, playground, refine, sync, cloud-init, mcp; plus ok, failedStep, errorClass, durationMs).
- [ ] Commit.

### Task C5: Wire the CLI

**Files:** modify `packages/vendo/src/cli/init.ts` (enriched props + per-stage timings), `packages/vendo/src/cli/shared.ts` if the factory needs the env passthrough, and the entrypoints of `extract/index.ts`, `theme/`, `eject.ts`, `playground.ts`, `refine.ts`, `sync.ts`, `cloud-init.ts`, `mcp/` to emit `command_run` (and `extract_completed` from extract). Add a small version-detection helper next to `packages/vendo/src/cli/framework.ts` that reads the host package.json dependency versions.

- [ ] TDD per entrypoint where a test file already exists (init.test.ts, eject.test.ts, playground.test.ts, refine.test.ts, sync.test.ts, cloud-init.test.ts, extraction.test.ts): assert the tracked event and its properties using an injected fetch/telemetry stub, matching existing test patterns.
- [ ] Fire-and-forget semantics preserved everywhere: a telemetry failure can never fail a command.
- [ ] Commit per command group.

### Task C6: Docs sync

**Files:** modify `TELEMETRY.md` (two-lane structure: existing anonymous table + new "When Vendo Cloud is configured" section), `docs-site/reference/environment-variables.mdx`, and any docs-site telemetry page.

- [ ] Mirror `events.ts` exactly; the existing mirror test must pass unchanged in spirit (update it to cover both lanes).
- [ ] Commit.

### Task C7: Integration test + CLI PR

**Files:** modify `fixtures/integration/src/telemetry-wire.e2e.test.ts`.

- [ ] Extend the wire test to assert both lanes: without a key (no cloud props present) and with a fake well-formed key (cloud props present, raw key absent from the payload).
- [ ] `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.
- [ ] Open PR (includes Workstream B's docs.json change).

## Workstream D — Live E2E launch gate

### Task D0: Yousef's PostHog-UI prerequisites (blocking, do first)

- [ ] Enable "Record user sessions" in the shared project's settings.
- [ ] Add `console.vendo.run` (and the staging console domain) plus `docs.vendo.run` to "Authorized domains for recordings."

### Task D1: CLI live verification

- [ ] From a test project (`~/vendo-test-repos`), run real `vendo init`, `vendo extract`, and a deliberately failing command — once without and once with a `VENDO_API_KEY`.
- [ ] In the PostHog activity feed (via Yousef's logged-in session in the Orca browser), confirm every expected event row and property for both lanes, and confirm the raw API key never appears anywhere in event payloads.

### Task D2: Console live verification

- [ ] On the staging deploy: click through login → keys → billing with the browser; confirm autocapture events, identify by email, all four activation events, and a watchable session recording with inputs and key reveals masked.
- [ ] Repeat a pageview with uBlock Origin enabled; confirm events still arrive through `/ingest`.
- [ ] Screenshots into the PR; merge and spot-check production.

### Task D3: Docs live verification

- [ ] After the flowlet PR merges and Mintlify redeploys, load docs.vendo.run, browse two pages, confirm pageviews and a session recording arrive tagged to the docs host.

## Sequencing for launch

D0 now → A1–A6 (console) → D2 → C1–C7 + B1 (single flowlet PR) → D1 → merge → D3. Console and CLI workstreams are in different repos and can run in parallel.
