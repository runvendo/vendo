# HANDOFF: demo-hygiene (vendo)

compiled: 2026-07-26 · source: SPEC.md (signed 2026-07-25) · branch: your Orca workspace branch

This file is your memory and your law. Re-read it after any restart or
compaction. The human is not available to you — you never ask them
anything. Genuine ambiguity this file doesn't answer → park it in
PARKED.md with evidence (exact command + output), take the most
reversible defensible default if you can continue, keep working other
tasks. You do not give up on tasks: failed approach → different
approach → systematic debugging → restart fresh from this file.
Stopping is for done or parked-with-evidence only.

## Goal

Close the demo hygiene holes for unattended customer play: Reset actually
resets (connections included), expired connection rows offer Reconnect,
Cadence's seed converges (today `on conflict do nothing` can never fix a
drifted password) with a localness-aware e2e guard, and the blank-page
problem gets pre-generated "try this" suggestion chips backed by REAL
pipeline output. The live hosted reseed itself is an OPS step the conductor
executes — you prepare and verify the mechanism.

## Orientation (do this before any work)
Summarize this contract back to the conductor in 5 sentences and ask
anything that would improve the result. Append every Q&A here.

### Orientation Q&A
<!-- append here -->

**2026-07-26 conductor update:** PR #575 MERGED ⇒ base is now origin/main; rebase.

**2026-07-26 checker verdict FAIL (3 findings), fixes ordered:**
- F1: restore the original first-visit regression test verbatim (single render + reference identity); make the chips change satisfy it or park.
- F2: criterion-26 evidence must be IN lane commits (PNGs were gitignored); screenshots with visible measured timings + cache-miss progress sequence under docs/verification/demo-live-readiness/hygiene/.
- F3: committed store-assertion script reads obsolete doc.nodes/doc.components; fix to doc.tree.nodes and commit passing output.

**2026-07-26 post-merge addendum (PR #601 merged; bot triage round, branch demo-hygiene-followup off current origin/main):**
- A1: chip pre-generation idempotency keys on the PROMPT (not chip.key) — an edited prompt regenerates; test: change a prompt, re-seed, manifest pairs the new prompt with a NEW app.
- A2: Cadence assistant/overlay threads pass discoverability="quiet" like Maple; test or screenshot.
- A3: pregenerateChips guards concurrent runs (boot + reset overlap) with an in-flight lock; unit test with two concurrent calls.
Full suite green once, commit, STATUS: DONE with sha. No PR — conductor lands it.


## Operating loop
1. GATHER: read progress.md + this file. Pick the first unfinished,
   unblocked task. Search the codebase before implementing anything.
2. ACT: that one task only. TDD for feature work.
3. VERIFY: run the task's criteria + all tier-1 and offline tier-3 tests.
4. RECORD: update progress.md; append one line to log.md.
5. Repeat. Files are your only memory.

## Pinned interfaces

- `ConnectionsService` (packages/vendo/src/connections.ts:42-51) is used
  as-is — list/disconnect exist on every impl; you add NO methods.
- You own: both demo hosts' reset routes and demo pages/components,
  packages/ui/src/chrome/connected-accounts-panel.tsx, demo-accounting
  supabase/seed.sql + login-e2e, and the new chips feature (demo-host-local:
  components + a small server piece; do NOT add chips to packages/ui — the
  scripted scenario cards are host-side in src/vendo/scenarios.tsx, follow
  that pattern).
- You do NOT touch: packages/automations, packages/actions, packages/agent,
  packages/apps generation internals, src/demo-script/engine.ts internals
  (grant-sets lane owns it) — chips may CALL the runtime's create/persist
  APIs and the demo config, not modify them.
- Approved mockup is visual law:
  docs/superpowers/specs/2026-07-25-demo-live-readiness-mockups.html
  (section 1 chips: light hairline pills under "Or try this" micro-label,
  one tier below scenario cards, instant attach; section 3 Reconnect:
  primary solid Reconnect with spinner, Disconnect demoted to quiet text
  button on non-active rows only). No emoji.

## Base branch fact

PR #575 (branch demo-tooling-wave) carries the reset routes and demo files.
Check `gh pr view 575 --json state`. MERGED ⇒ base origin/main; OPEN ⇒ base
origin/demo-tooling-wave. Verify apps/demo-bank/src/app/api/demo/reset/
route.ts exists in your worktree before starting.

## Tasks

T1 — Reset sweeps connections [criterion 27].
what: in apps/demo-bank/src/app/api/demo/reset/route.ts, alongside the
erase.bySubject loop: posture-guarded sweep — if
`vendo.connections.posture !== false`, for each demo subject
`list(principal)` then `disconnect(principal, account.connector,
account.id)` per row; tolerate per-row failures (log, continue). Mirror
into apps/demo-accounting's reset route (it currently only resetStore()s).
criteria: [1] #27 (unit test with a fake ConnectionsService: 2 connections
⇒ 2 disconnect calls, post-list empty; posture:false ⇒ no calls, no error).

T2 — Reconnect affordance [criterion 28].
what: packages/ui/src/chrome/connected-accounts-panel.tsx — non-active rows
(expired/failed) lead with a primary Reconnect action that triggers the
existing initiate/complete connection flow (completeConnection is already
imported); Disconnect demoted to secondary quiet action per mockup; active
rows unchanged.
criteria: [1] #28 (jsdom test: expired row renders Reconnect primary;
click calls the connect flow).

T3 — Cadence seed converges [criterion 29].
what: apps/demo-accounting/supabase/seed.sql:53 — `on conflict (id) do
update set encrypted_password = excluded.encrypted_password, email =
excluded.email, updated_at = now()` (and review the :86 identities conflict
clause for the same no-op trap). Collapse the "cadence-demo" literal to ONE
source of truth: keep src/server/users.ts `cadenceDemoPassword()` as canon;
seed.sql documents it; update README.md and bench/src/demo-capture/hosts.ts
references to point at the canon. Verify locally: `supabase start`, apply
seed twice with a password-drifted row in between, login succeeds.
criteria: [1] #29.

T4 — Localness-aware e2e guard [criterion 30].
what: apps/demo-accounting/src/vendo/login-e2e.test.ts:19-30 — skip unless
supabaseUrl() resolves to loopback OR CADENCE_E2E_SUPABASE=live is
explicitly set; skip reason names the guard. Also pin the child env overlay
in the bootCadence call (:71-74) so the suite can't inherit ambient live
config (e2e-harness bootCadence(distDir, env) supports it; away-drill.test
.ts:139 shows the pattern).
criteria: [1] #30 (test the guard logic itself: non-loopback URL without
opt-in ⇒ skip with reason).

T5 — Nightly login canary [criterion 31].
what: a canary spec (tier-4, never blocks): hits the HOSTED Cadence
Supabase login with seeded creds when CADENCE_CANARY=1 + env creds present;
green=silent, red=named failure. Put it where the corpus/canary tooling can
run it; scheduling onto the mini is the conductor's job — note the exact
command in progress.md.
criteria: [4] #31.

T6 — Prepare the live reseed (OPS — prepare only, DO NOT EXECUTE).
what: write docs/verification/demo-live-readiness/hygiene/reseed-runbook.md:
the exact GoTrue admin call (PUT /auth/v1/admin/users/:id password reset)
or service-role SQL UPDATE for the two pinned user ids
(src/server/users.ts:20-30), the env each needs (SUPABASE_JWT_SECRET /
SUPABASE_ANON_KEY requirements from users.ts:71-82), and the verification
command (T5 canary one-shot). The conductor executes it against prod.
proves: reseed is one paste away, zero guessing.

T7 — Suggestion chips [criteria 24, 25, 26].
what: demo-host-local feature, both hosts:
(a) Curate 5 prompts per host (Maple: realistic bank asks distinct from the
4 scripted beats; Cadence: accounting asks). Store in the host's vendo dir
next to scenarios.tsx.
(b) Pre-generation: at seed time (demo-bank: seedDemoScript boot path +
reset; demo-accounting equivalent) generate each prompt's app through the
REAL runtime create pipeline and persist to the host store, recording a
chip→appId manifest. Generation is fire-and-forget after boot (an awaited
seed deadlocks PGlite's cross-process writer lock — known gotcha), and
idempotent (existing cached app ⇒ skip).
(c) Chip row UI per mockup section 1, rendered near the scenario cards;
tap ⇒ attach the cached app instantly (follow how scripted beats attach
apps); cache miss ⇒ fall through to a normal live generation of that
prompt; empty manifest ⇒ row absent.
criteria: [1] #24 (render N chips / absent when empty), [2] #25 (post-seed:
store contains real generated apps, not fixtures — assert via store), [3]
#26 (recording: tap ⇒ attach ≤ 2s; cache-miss path shows normal progress).
risk: model spend at seed/reset (~5 apps) is accepted; keep prompts short.

## Contract criteria (verbatim from SPEC.md for this lane)

24. [1] Given a pre-generation cache with N apps, when the Vendo surface
    renders, then N chips show; given an empty cache, then the chip row is
    absent entirely.
25. [2] Given deploy/reset, when pre-generation runs, then each curated
    prompt produces a real pipeline-generated app persisted to the cache
    (assert via store, not fixtures).
26. [3] Given the deployed demo, when a chip is tapped, then the app attaches
    ≤ 2s (cache hit) — recording in PR; given a cache miss, then live
    generation runs with normal progress UI (no error).
27. [1] Given a demo subject with 2 connections (1 active, 1 expired), when
    Reset runs, then connections.disconnect was called for each and the
    post-reset list() is empty; given posture false, then reset completes
    without error and without calling disconnect.
28. [1] Given an expired connection row, when the accounts panel renders,
    then Reconnect is the primary action and triggers the initiate/complete
    flow; Disconnect remains available as secondary.
29. [1] Given the Cadence seed applied over an existing user row with a
    different password, when re-applied, then login with cadence-demo
    succeeds (seed converges).
30. [1] Given SUPABASE_URL pointing at a non-loopback host without the
    explicit live opt-in env, when login-e2e runs, then the suite SKIPS
    with a reason naming the guard.
31. [4] Given the hosted Cadence Supabase, when the nightly login canary
    runs, then seeded login succeeds (drift detector; never blocks).

## Facts you'd otherwise have to rediscover

- Reset today: eraseDoor (HostedStore.erase.bySubject or eraseStore) →
  mapleDemoUsers loop → seedDemoScript; guard grants DO get erased;
  connections don't.
- Connections survive deploys too (Cloud-side) — the sweep at reset is the
  designed cleanup point.
- Cadence auth: GoTrue password grant POST from src/app/login/route.ts:
  110-114; session verify offline HS256 + remote JWKS ES256
  (src/server/session.ts:54-85).
- Deployed Maple posture: Cloud hosted store + VENDO_API_KEY; local dev
  MAPLE_STORE=local; keys `source "/Users/yousefh/Desktop/Cool Code/
  flowlet/.env"`.
- Known-red baseline: the login-e2e YOU are fixing is the known red — fix
  the guard first (T4), then the suite is your proof, not your blocker.
- CI `audit` flake = npm registry outage — rerun, never "fix" deps.

## Guardrails
- Never weaken/delete/reinterpret a criterion — park with evidence.
- Your worktree/branch only; never main; never another lane's files.
- NO prod-data mutation: T6 is prepare-only; the conductor runs it.
- No emails, no spend beyond live-key test runs + the ~5-app pre-generation,
  no secrets in code/output. Never edit this file above the Q&A section.
- One dev server; kill what you start. No destructive git.
- Canary failures: log, flag, move on.

## When done
All criteria pass, full suite green twice (`pnpm build && pnpm test &&
pnpm typecheck && pnpm lint`) → E2E user proof (chips recording, Reconnect
click, reset sweep in a real browser) → RUN SUMMARY at top of progress.md →
exit report printed as a `STATUS: DONE` block: impact one-liner · per-task
status · evidence paths · parked items · deviations · unrelated issues
noticed (never fixed).
