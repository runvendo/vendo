# Production Hardening — Design

Date: 2026-07-14
Linear: Production hardening (ENG) — https://linear.app/runvendo/project/production-hardening-1f54a8860901

## Outcome

GA-honest quality across the board: strangers run Vendo in production against their
real users and nothing that belongs to no feature project — test coverage, security
posture, release discipline, performance, docs/status drift — is left unowned.

## The hardening bar (standing definition of done)

- Every user-visible journey has a real end-to-end test plus a captured demo/GIF on a
  real demo host (Maple/Cadence). Perf fixes carry before/after numbers.
- Per-package coverage floors are wired, ratchet from measured reality, and never
  regress. `--passWithNoTests` is removed so an emptied suite can no longer pass green.
- The frozen contracts describe what actually landed. A spec that lies is worse than an
  unfrozen one; every amendment is dated and noted in place.
- The release path is proven end-to-end, not theoretical.

## Scope decision

This project owns all defect and coverage debt surfaced by examination, regardless of
which block it lives in. Block projects stay vision-driven (new capability); hardening
owns the quality gaps.

## Cadence

A continuous standing loop: examination → triage with Yousef → a scoped batch of fixes
as PRs → re-examine. Wave 1 is defined below; the loop keeps running toward GA.

## Examination findings (2026-07-14)

Five sub-agents read the code. Headlines:

- **Security**: `substituteSecretHandles` is dead code in both OSS sandbox paths — an OSS
  app that declares secrets gets opaque handles that can never authenticate. No Vendo-side
  SSRF/private-IP guard. Run tokens replayable within their 15-min TTL. `/tick` bearer
  compared non-constant-time. OAuth-protocol and CSRF adversarial coverage absent from the
  red-team wave (code is defended).
- **Performance**: two P0s, both the automations tick — `runTick` full-table-scans all apps
  for all subjects, N+1 gets, executes fired automations sequentially inline, and `/tick`
  awaits the whole thing (serverless timeout risk). Agent path re-sends the full ever-growing
  thread plus static system prompt uncached every turn, tool output uncapped by default.
  Thread listing loads full message bodies; `vendo_records` lacks an index for its own
  default ordering.
- **Coverage**: no coverage provider wired anywhere; all 12 packages run `--passWithNoTests`.
  Thin spots: automations (1288-LOC engine, 1 test file), mcp (door + oauth server), ~10
  zero-test hot-path modules. Integration suite has 7 journeys; missing actions-sync,
  Postgres-durability, multi-tenant-concurrency, telemetry.
- **Docs/contracts**: the MCP door landed but frozen contracts still call it deferred/reserved
  (00-overview, 01-core venue + grant-source + audit-kind, 09-vendo config/routes/CLI). mcp
  package self-labels "Skeleton"; 10-mcp labeled DRAFT while its body says LANDED.
- **Release/CI**: `release.yml` has never run (no tags; publishes were manual), skips
  typecheck/lint, no provenance, no changesets/CHANGELOGs. `perf` runs on PRs but doesn't
  block. Corpus nightly swallows failures with `|| true`. No renovate/dependabot, no audit
  gate. One moderate audit finding (postcss). CI flake localized to `@vendoai/ui` tree/voice.

## Wave 1 — six workstreams

Each workstream runs as an isolated executor lane producing one or more PRs. Lanes work in
separate worktrees so parallel edits cannot collide; the orchestrator sequences merges and
rebases later lanes over earlier ones.

1. **Security batch** — run-token jti/single-use anti-replay; timing-safe `/tick` compare;
   OAuth + CSRF adversarial tests added to the red-team wave; postcss bump. Prior-wave
   leftovers folded in: bound the ephemeral-subject Set, StackOptions judge/breakers
   passthrough, add `@vendoai/mcp` to the corpus local-pack list.

2. **Performance batch** — tick fixed in place (indexed/filtered schedule query, kill the
   N+1, bounded parallel execution with per-run timeout so one hung run can't block other
   tenants); agent context (Anthropic prompt caching, default tool-output cap, history-window
   knob, thread-list slimming plus the missing `(collection, created_at, id)` btree index).
   P2/P3 findings queue for a later wave.

3. **Coverage batch** — wire `@vitest/coverage-v8` across all packages; ratchet floors from
   measured reality as a required check; remove `--passWithNoTests`; unit tests for the
   automations engine, mcp door + oauth server, and the ten zero-test hot-path modules; new
   e2e journeys J8 actions-sync, J9 Postgres-durability, J10 multi-tenant-concurrency,
   J11 telemetry-wire — each with a captured GIF on a demo host.

4. **Docs/contracts batch** — amend the frozen contracts to landed reality with dated
   amendment notes; fix the mcp "Skeleton" header and the 10-mcp DRAFT label.

5. **Release/CI batch** — adopt changesets (fixed lockstep group); bring `release.yml` to PR-gate
   parity (typecheck + lint + dependency-guard) with npm provenance; prove it by cutting a real
   v0.3.1 through the workflow; make `perf` a required check; make the corpus nightly fail
   loudly instead of swallowing errors; add renovate + a pnpm-audit gate. Branch protection
   stays 0-approval to preserve autonomous merge authority.

6. **Child sub-project — OSS egress proxy** — its own orchestrated lane: an allowlist-gated
   egress route on the apps proxy that performs `substituteSecretHandles` server-side so a
   declared secret becomes functional in OSS single-player, with a Vendo-side SSRF/private-IP
   guard, adversarial tests, and live-e2b verification. Contracts amended to describe it.

## Decisions locked with Yousef

- Hardening fixes all findings (not just cross-cutting).
- Coverage bar = journey-first + a ratchet-from-reality numeric floor.
- Frozen contracts are amended to match reality with dated in-place notes.
- Full release train, proven with a real v0.3.1 cut.
- OSS egress proxy gets built (the secret hole is a functional gap, not posture).
- Tick fix is minimal-in-place, not a durable job queue (revisit if bench shows a cliff).
- Standing agenda item: cloud-aligned.

## Non-goals for wave 1

Durable async job queue for automations; requiring PR approvals (breaks the fleet's
autonomous merge); the P2/P3 perf items (app-open parallelism, MCP session sweep, PGlite
pooling, UI render memoization) — queued, not dropped.
