# Usage & Pricing v3 — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-07-24-usage-and-pricing-design.md`
**Goal:** make the six meters real (counted, enforced, billed) and ship the billing machinery — Stripe, credits, spend caps, bundles — across `runvendo/vendo` and `runvendo/vendo-web` in tandem.
**Style note:** per team convention this plan is high-level — goals, steps, decisions. Each phase names its repo(s), its deliverable, and how we know it works. Exact file-level scoping happens at phase kickoff against the then-current code.

## Where we start (audited 2026-07-24)

- `vendo-web` branch `console-metering-and-model-ids` (in flight) already has: project-scoped usage-event ingestion (`lib/usage-ingestion.ts`, `lib/metering/`), the broker meter outbox with project/api-key attribution, per-project storage gauges, and loud gateway model-id validation. This plan **builds on that branch's work; nothing here duplicates it.**
- Gateway dual-metering of `llm_tokens` shipped in the cloud program; Stripe overage forwarding was explicitly left undone.
- **No Stripe code exists in `vendo-web`, but the Stripe account is live and test mode has scaffolding** (audited via CLI 2026-07-24): `vendo_pro`/`vendo_teams` products, billing meters `storage_gb`/`runs`/`sandbox_minutes`, metered overage prices with per-tier lookup keys. Phase 3 reconciles this to the canon rather than starting blank: add `knowledge_gb` + `active_connections` + AI netting, and replace the per-tier price objects with one uniform price per meter (per the uniform-rates decision).
- No service door enforces allowances today (the 247K-over Free org incident).
- OSS (`vendo`) already has safe stream-error surfacing to the thread banner and terminal-failure turn-ending — the natural rails for meter-exhausted errors.

## Phase 1 — Meter canon & counters (`vendo-web`)

Make the six spec meters the only vocabulary in the metering layer.

- Define the canonical meter set (ai_tokens, sandbox_minutes, storage_gb, knowledge_gb, automation_runs, active_connections) with per-plan allowances and list rates in one config module — the same source that will later render the public rate sheet.
- Split storage gauges: files + app data vs knowledge (docs + vectors). Threads, memory, and audit logs are excluded from gauges entirely (unmetered by spec).
- Derive **active connections** from broker traffic: distinct (end-user × integration) pairs with ≥1 broker-mediated action per calendar month; automation-initiated actions count; token refreshes/health checks/connect events don't. Expose the "which connections counted and why" breakdown the spec promises.
- Count **automation runs** at the scheduler (hosted executions only; chat paths never emit this meter).
- Billing-month windows per org (anchor = subscription cycle once Stripe exists; calendar month until then).
- Done when: a console-internal usage view shows all six meters for a seeded org and matches hand-computed fixtures.

## Phase 2 — Enforcement at the doors (`vendo-web` + `vendo`)

The "meters aren't real" fix. Ship dark first, then flip.

- One meter-check helper used by every service door: gateway, hosted store, managed sandbox, connections broker, automation scheduler. Check = valid key + plan allowances + (overage enabled ? under spend cap : under allowance), with the ~5% metering-lag tolerance.
- Structured refusal body on every door: which meter, current usage vs limit, reset date, and the two exits (upgrade / BYO). One shape, all services.
- Free tier: hard stop. Paid with overage off: same, plus enable-overage pointer. Enterprise orgs: never refused (flag on org).
- Automations at a stop: run recorded as "blocked by allowance/spend cap" + owner email — loud, never silently unfired.
- **Dark launch:** enforce in log-only mode for ≥1 week, compare would-block events against real orgs, then flip. The 247K incident becomes the regression test: seeded Free org exceeding its AI allowance gets refused at the gateway within tolerance.
- OSS half (`vendo`): meter-refusal errors surface as the existing terminal stream-error path (thread banner text names the meter and reset date, turn ends); CLI/doctor prints the same when service calls refuse; no client-side checks of any kind (locked constraint).

## Phase 3 — Stripe foundation (`vendo-web`)

- Stripe products/prices: three plans (monthly + annual at ~2 months free), six metered prices at list rates, tax config.
- Checkout + customer portal for plan changes; subscription state and plan mapped onto orgs; Free requires no card ever.
- Usage pipeline: meter counters → Stripe meter events (overage beyond allowances only, credits netted for ai_tokens).
- Mid-cycle settlement threshold via Stripe billing thresholds at max($100, 1× plan).
- Dunning: Stripe retry schedule → grace window (7–14 days, warning emails) → org flips to hard-stop enforcement; no debt accrual past the flip.
- Done when: on Stripe test clocks, a Pro org upgrades, exceeds an allowance with overage on, crosses the settlement threshold mid-cycle, receives the month-end invoice with correct netting, and a failed card walks the full dunning path to hard-stop.

## Phase 4 — Controls & trust surfaces (`vendo-web`)

- Overage toggle (default off on Pro, on on Teams) with the enable prompt showing rates; consent recorded.
- Customer spend cap, default-on at 2× plan, one-click adjust; cap-hit behavior = hard stop semantics from Phase 2.
- Notifications at 50/80/100% of allowances and cap (email; console banner).
- Console billing pages: per-meter usage with history, invoices, toggle + cap controls, connections-counted breakdown.
- Public rate sheet page rendered from the Phase 1 config module (single source of truth; "passthrough +15%" verifiable).
- Done when: a design partner can self-explain their invoice from the console alone.

## Phase 5 — Retention windows (`vendo-web`)

- TTL sweeps for threads/sessions and audit logs per plan (7d Free / 90d Pro / unlimited threads + 1-yr audit on Teams / custom enterprise). Memory unmetered and unswept except with threads policy where applicable.
- Deletion is lazy and recoverable for a grace period internally (operational safety), but externally honest.
- Done when: seeded Free org's 8-day-old thread is gone; Teams org's isn't.

## Phase 6 — Model family rates (`vendo-web`, depends on the model-ids lane)

- Per-alias rate rows for `vendo`, `vendo-paint`, `vendo-judge`, `vendo-extract`: fixed published per-token prices, initially set at each alias's current underlying model × passthrough+15% equivalence.
- Literal provider ids through the gateway meter at provider list +15%.
- Rate resolution keys on the *requested* model id (alias or literal), never the routed target — retuning the alias mapping must not move billing.
- Done when: the same prompt through `vendo` and through its current concrete model bills the same today, and retuning the alias changes COGS but not the customer's rate.

## Phase 7 — Usage bundles (`vendo-web`)

- Recurring add-on: pay $X/mo (min $100) → $X × 1.10 usage credit at list rates; draw order allowances → bundle → metered; one-month rollover; cancel anytime.
- Implemented as a credit-grant ledger consulted by the same netting step that applies plan AI credits (Phase 3), plus a Stripe recurring line item.
- Done when: test-clock org with a $100 bundle shows correct draw order and rollover across two cycles.

## Phase 8 — Enterprise plumbing (minimal, `vendo-web`)

- Org-level enterprise flag: never hard-stop (already honored in Phase 2), committed rate table, commit ledger.
- Quarterly true-up export (usage beyond commit at committed rates) suitable for manual invoicing — no automation beyond the export in v1.
- SAML SSO configuration gates on the enterprise flag (spec change: SSO left Teams), alongside SCIM when it exists.
- Done when: the design-partner org can be flagged, draws down a commit, and the true-up export matches fixtures.

## Sequencing & dependencies

1 → 2 → 3 → 4 are strictly ordered. 5 is independent after 1. 6 waits on the console model-ids lane landing. 7 needs 3. 8 needs 2 + 3. The tandem rule holds throughout: Phase 2 is the only phase with an OSS half; it ships in the same wave as its `vendo-web` half.

## Explicitly out of scope

- Public pricing-page redesign (blocked on COGS validation of allowance numbers — spec §10).
- Graduated-rate breakpoints (need real usage data; config module supports tiered rates from day one so adding them later is a config change).
- Enterprise contract automation, SOC 2 work, deployment rungs (separate Linear projects).
- The router/retuning logic itself (model family lane owns it; this plan only prices it).

## Risks

- **Double-billing seams:** credits netting + bundle draw + Stripe meter events must be one pipeline stage with property tests, not three ad-hoc adjustments.
- **Enforcement flip:** dark-launch comparison is mandatory; flipping enforcement on real orgs without it risks cutting off paying customers on counter bugs.
- **Branch coordination (resolved 2026-07-24):** `console-metering-and-model-ids` lands on main first; `pricing-p1-meter-canon` then rebases onto main and PRs. Pricing phases queue behind the metering lane.
