# Vendo Usage & Pricing v3 — Design

**Date:** 2026-07-24
**Status:** Approved in brainstorm (Yousef), pending spec review
**Supersedes:** Pricing v2 (2026-07-15, Notion Pricing page). Tier names and price points carry over; meter definitions, allowances, enforcement, billing mechanics, and enterprise structure are re-derived here.

## Why now

Three triggers: (1) metering enforcement is soft today — a Free org 247K tokens over allowance was still served during the 0.4.x cert campaign; billing cannot be built without precise meter/enforcement definitions. (2) The first on-prem deal ($15k/yr offer for Rung 2, ~4× under band) exposed enterprise packaging as untested. (3) Cloud has actually shipped since v2 (gateway, hosted store, sandbox, broker), so tier contents can be derived from what exists.

This spec is the source of truth for what each tier contains, what the meters are, what happens when allowances run out, and how money is collected. Implementation spans both repos (metering/enforcement seams in `runvendo/vendo` service calls; billing, Stripe, console UI in `runvendo/vendo-web`) and must be scoped in tandem, per standing rule.

## Constraints (locked elsewhere, inherited here)

- **Gating = valid key + meter, nothing else.** No capability booleans, no entitlement protocol, no validate endpoint. Tier differentiation is only: quotas/meters + server-side multi-party services.
- **Hard BYO rule:** every single-player capability keeps a keyless path. Every meter is therefore *conditional* — bring your own (model key, sandbox, Postgres, Composio/OAuth apps) and that meter never ticks.
- **OSS = complete single-player tier, free forever.**

## 1. Packaging shape

**One SKU.** Every plan includes every block; meters and multi-party surfaces differentiate. No per-block pricing, no à-la-carte SKUs.

## 2. Tier ladder

Free $0 / Pro $49/mo / Teams $499/mo / Enterprise custom. The Pro→Teams line is **organizational shape** (collaboration vs. governance), never usage: no meter allowance is tier-locked in a way that forces upgrades — a solo dev with huge usage stays on Pro and pays meters. Enterprise has two doors: organizational (compliance/control) and scale (committed usage becomes cheaper than metered — see §8).

| | Free | Pro $49 | Teams $499 | Enterprise |
|---|---|---|---|---|
| **Persona** | Dev evaluating; zero config, never talks to us | Indie/startup live in production | B2B company; org structure, governance | Regulated ICP; buys risk transfer + control, or arrives via scale |
| **Multi-party surfaces** | None | Snapshot share links, live collab apps, publishing; basic console (usage, keys, deployments) | + Org layer (overlay, org principals, registry + promotion, pinning/host-adoption); full governance console (guard hot-edit, batch approvals, session replay, org activity, insights) | + SAML SSO, SCIM, custom RBAC, multi-org/subsidiaries |
| **AI credit (managed inference)** | $5/mo, hard stop | $10/mo, then passthrough +15% | $50/mo, then passthrough +15% | Committed rates |
| **Sandbox minutes** | 200, hard cap | 2,000 incl., then $0.01/min | 10,000 incl., then $0.01/min | Committed |
| **Storage — files & app data (GB-mo)** | 1 GB, hard cap | 20 GB incl., then $0.25/GB-mo | 100 GB incl., then $0.25/GB-mo | Committed |
| **Knowledge base (GB-mo)** | 1 GB, hard cap | 10 GB incl., then $0.60/GB-mo | 50 GB incl., then $0.60/GB-mo | Committed |
| **Automation runs** | 300/mo, hard cap | 3,000/mo incl., then $3/1k | 30,000/mo incl., then $3/1k | Committed |
| **Active connections** | 20, hard cap | 150 incl., then ~$0.30/conn-mo | 2,000 incl., then ~$0.30/conn-mo | Committed |
| **Threads, memory, audit logs** | Free — 7-day retention | Free — 90-day retention | Free — unlimited threads; 1-yr audit retention | Free — custom / compliance-grade retention |
| **Support** | Community | Email | Priority | Named SE, private channel, SLA |

All allowance and overage numbers are structural placeholders **pending COGS validation against real usage data** before the pricing page ships. The structure (which meters exist, hard-stop vs overage, ratios between tiers) is the locked part. Free runs raised 100→300 on 2026-07-26 from live evidence: a real evaluation sprint burns ~100/day; 300 holds three sprint days while staying under half of one hourly job.

## 3. The six meters

A meter exists only where Cloud carries real marginal COGS *and* a BYO escape hatch exists. Everything else is tier contents, not usage. **Overage rates are identical on Pro and Teams** — one public rate per meter; only volume graduation (§6) lowers it.

1. **Managed AI (tokens)** — provider passthrough +15%, dual-metered at the gateway; margin graduates with spend volume (§6), never by tier. BYO model key → $0. Public rate sheet; "passthrough" must stay verifiable. Never called a "gateway" in marketing — it is *managed inference* (gateways charge 0%; workflow-embedded resale sustains 10–20%: Zed +10%, Cursor ~+20%).
   **Model exposure & router (locked; family per `2026-07-22-vendo-models-demo-refresh-design.md` on demo-2):** two rails on the rate sheet.
   - **The vendo model family** — `vendo` (flagship agent), `vendo-paint` (instant first-frame), `vendo-judge` (guard rulings), `vendo-extract` (init/sync extraction) — job-named hosted models, the Cloud-rung slot defaults. Each is its own rate-sheet row with a **fixed published per-token price we set**, launching at its current underlying model's passthrough+15% equivalence (flagship ≈ Sonnet-class; paint/judge ≈ fast-tier and priced visibly cheap — judge is called constantly and its cheapness is a selling point). The gateway maps names to concrete models server-side; **retuning the mapping never changes a published rate mid-term** (change policy §7 applies) — routing skill grows margin silently, and a future Vendo-trained model is just a routing target, zero pricing event. New family members = new rows; the token unit is never redefined.
   - **Literal provider models** (`claude-sonnet-5`, … passed verbatim through the gateway) — passthrough +15%, **never routed, downgraded, or failed-over**. Naming = getting exactly that model; this preserves the verifiable-passthrough claim and is the trust valve against router suspicion (the Cursor-Auto lesson).
   - Principles: the vendo-* names are the default surface (job names never churn; provider names churn quarterly); the rate sheet is additive; credits and enforcement are dollar-denominated and unchanged by any of this; the family exists only on the managed path (BYO rungs never see vendo-* names, per the family spec) — routing/failover/retuning/one-bill is the feature differentiator of managed inference vs BYO.

2. **Sandbox minutes** — includes app-build compute. BYO E2B/own sandbox → $0.
3. **Storage GB-month (files & app data)** — uploaded files/attachments, app-owned data records, app documents + versions in the hosted store. **Architecture locked 2026-07-24: file bytes live in R2, rows in Neon** — this is what keeps $0.25/GB-mo margin-positive (all-Neon backing would be underwater at Neon's $0.35/GB-mo). BYO Postgres → $0.
4. **Knowledge base GB-month** — knowledge docs + their vectors, as its own meter and allowance, at **$0.60/GB-mo** (COGS-validated 2026-07-24: vectors + absorbed one-time ingestion of ~$0.50–5/GB made $0.35 breakeven-to-negative; can drop to ~$0.50 later if a quantized-vector stack ships — rate *decreases* are always safe under §7); retrieval is free (rounding error vs. the generation call). Guardrails, not meters: per-file upload cap on Free, plus a monthly *ingestion* allowance decoupled from stored GB (kills delete/re-upload OCR farming — the one unbounded free vector per `docs/pricing/free-abuse-sizing.md`); pathological cases go to contract terms. BYO RAG stack → $0.
5. **Automation runs** — a hosted automation execution (scheduled/triggered). **Interactive chat is never a run** (no double-metering a conversation that already pays the AI meter).
6. **Active connections** — a user × integration pair (Sarah's Gmail = 1, her Slack = a 2nd) that performed ≥1 broker-mediated action in the calendar month. Automation-initiated actions count (real Composio COGS); a failed action still counts (the broker call was made and billed to us); token refreshes, health checks, connect/disconnect events, quota refusals, and dormant stored credentials do not. Console shows exactly which connections counted and why. Fair-use clause on per-connection call volume backstops the loose calls↔connections correlation (our vendor COGS is per tool call, ~$0.11/1k). BYO Composio key / host-side OAuth → $0.

**Unmetered (deliberately free):** threads/sessions, agent memory, and audit logs. They're text — even a heavy org is single-digit GB, pennies of COGS — so charging would be friction without revenue. Tiers differentiate on **retention windows** instead (7d / 90d / unlimited / custom), which is the packaging the market already uses for exactly this.

**Mapping rule (locked):** new services must map onto existing meters — memory → free (retention-tiered); embedding/retrieval inference → AI tokens; app builds → sandbox minutes. The meter set stays at six. **The meter unit definitions are permanent** — every 2025–26 repricing disaster (Cursor, Copilot, v0) was a mid-flight unit redefinition; we never redefine, only re-rate with grandfathering (§7).

## 4. Bundled AI credits

$5 Free / $10 Pro / $50 Teams per month. Dollar-denominated, no rollover, netted on the invoice.

- Sized to the **Supabase pattern** (credit covers the default/eval footprint), not the Cursor pattern (~100% of plan price): ~$0.05/chat turn and ~$1–2/app build on Sonnet-class models → Free ≈ 100 turns (the README demo + tinkering), Pro ≈ 200 turns/mo (the developer building), Teams ≈ 1,000 turns/mo (a team building or tiny pilot).
- The +15% margin is uniform across self-serve tiers; larger credits are the paid tiers' AI advantage, volume graduation (§6) is the discount path.
- **Marketing rule:** credits are "enough to build and try it" — never "AI included." They intentionally cannot cover end-user production traffic (100 end-users × 10 turns ≈ $50/mo).
- The AI meter is an on-ramp, not a profit center: at +15%, margin is thin by design; plan fees and the infra meters are the revenue lines.

## 5. Enforcement (what "meter exhausted" means)

Enforcement is server-side at service-call time — gateway, sandbox, store, broker, automation scheduler each check `valid key + meter not exhausted` before doing work. No client-side checks. ~5% internal tolerance absorbs async metering lag.

- **Enforcement is unconditional** (simplified 2026-07-26 post-flip: the off/log_only observation modes and per-org mode overrides were dark-launch migration equipment, deleted once enforcement went live; blocked-event logging remains for alert throttling and the console tally; emergency rollback = revert, not a mode flip).
- **Free: hard stop** at 100% of any cap, with a developer-readable error naming the reset date and the two exits (upgrade / BYO). Warning email at 80%. No card, ever. **Signup gate (locked 2026-07-24; grandfathering resolved same day):** applies to **new signups only** — every org created before the enforcement flip keeps full Free caps regardless of signup method (residual farm exposure is bounded and self-drains via idle decay). New email-only signups get the reduced lane — $1 AI credit, 50 sandbox min, 0.25 GB storage, 0.25 GB knowledge, 25 runs, 5 connections — and unlock full Free caps instantly by linking GitHub/Google (account-age heuristic, the Railway model). Idle decay per `docs/pricing/free-abuse-sizing.md` (warn d14 → pause d21 → delete after 90 days paused).
- **Pro/Teams: overage requires explicit opt-in** (toggle default **off** on Pro, **on** on Teams). Toggle off → Free-style hard stop at allowance with an enable prompt showing the rates. Toggle on → silent metered accrual under a **customer spend cap** (default on at 2× plan price, one-click adjustable); at cap, hard-stop behavior. Notifications at 50/80/100% of allowances and cap.
- **Degrade asymmetry:** inference/sandbox/storage/knowledge stop instantly at a cap; automations and connections fail *loudly* (run marked "blocked by spend cap" in console + owner email) — never silently unfired.
- **Enterprise never hard-stops.** Overage is a true-up invoice line, not a service gate; protection is contractual.

## 6. Billing mechanics

Stripe subscription + six metered prices + billing thresholds + one opt-in toggle. No prepaid wallet, no credit packs.

- **Monthly invoice** = plan fee + per-meter overage lines (credits netted), on the subscription card. Line items are the six meters at public rates — the bill self-documents.
- **Mid-cycle settlement threshold (our exposure control):** when accrued overage crosses max($100, 1× plan price), Stripe invoices and charges immediately; tab resets. Bounds our bad-debt exposure per customer to ~one threshold and surfaces runaway usage to the customer within days, not at month-end.
- **Spend cap (their control)** sits on top, per §5.
- **Failed payment:** Stripe dunning → 7–14 day grace with warnings → meters flip to hard-stop; no new debt accrues past the flip.
- **Annual self-serve:** offered at ~2 months free.
- **Usage bundles (Pro/Teams add-on):** an optional recurring monthly commitment — pay $X/mo (self-serve picker, $100 minimum), receive **$X × 1.10 of usage credit** drawn across all six meters at list rates (bonus framing, not per-meter discounts: margins stay computable, no asterisks, graduated rates still apply at list). Draw order: included allowances → bundle credit → metered overage. Unused bundle credit rolls over one month, then expires. Cancel anytime. Deeper discounts (20–30%) remain enterprise-commit territory, where they carry the platform fee.
- **Graduated meter rates on all tiers:** per-unit prices step down automatically at volume breakpoints (e.g. runs $3/1k → $2/1k past 50k/mo; storage $0.25 → $0.15/GB past 500 GB; AI margin +15% → +12% → +10% at spend tiers, funded by our own provider volume discounts). High-usage customers feel scale economics without a sales conversation and may stay on Teams forever.

## 7. Change policy (trust)

Meter units are never redefined. Rate or credit changes: existing subscribers keep current terms through their billing term, 30+ days notice. This single policy separates the accepted pricing changes from the 2025–26 revolts.

## 8. Enterprise

**Structure: platform fee + usage commit**, both annual, invoiced up front (net-30/60), no card.

- **Platform fee $15k/yr, never discounted.** Buys the enterprise surfaces: MSA + indemnification, SLA with credits, SSO+SCIM, SOC 2 report access, compliance paper, audit retention, named support. Exists so usage can't be negotiated to zero while consuming legal/compliance overhead.
- **Minimum commit $15k/yr** at 20–30% discounted meter rates (discount scales with commit), billed "greater of floor or actual," quarterly true-up above commit.
- **Effective floor: $30k/yr.**

**Internal bands** (publish "custom"; quote Band 2, land Band 1):
- **Band 1 ~$30–50k:** standard SaaS enterprise.
- **Band 2 ~$60–90k:** deployment control. Rung 2 (cloud half on customer infra) is a **+$30k/yr minimum add-on**; provisioned inference throughput and dedicated/single-tenant infra live here.
- **Band 3 $120k+:** air-gapped, dedicated everything, multi-region, custom paper.

**Scale door math:** at ~$50–60k/yr of actual metered usage, a commit at 25% off cancels the platform fee — enterprise becomes strictly cheaper than metered Teams, and billing data gives sales the trigger list. Below that, graduated rates (§6) carry the customer; no forced upgrade.

**Design-partner policy** (formalizes the $15k/Rung-2 deal): contract states list price with a named "Year-1 design partner discount" line; 1-year term; renewal at list or renegotiation; contractual consideration required (logo, case study, references); capped at 1–2 such deals ever. The discount is visibly an exception, never a price point.

**Guarantee mechanics:** annual prepay inherent (fee + commit up front); multi-year at 5–10%/yr escalators; professional services (onboarding ~$10–25k fixed; custom adapter work scoped) invoiced separately.

**Never billed, any tier, including enterprise:** host end-user counts, dev seats, resolutions/outcomes. Scale surfaces only through meters.

## 9. Deferred (explicitly not in v1)

- Marketplace/registry monetization; multi-region self-serve; per-region pricing.
- Additional vendo-* family members beyond the four defined (each would be a new rate-sheet row).

## 10. Open items before the pricing page ships

- ~~Validate every allowance/overage number against real COGS~~ **done 2026-07-24** (`docs/pricing/cogs-validation.md`); both rate decisions **resolved by Yousef same day**: files-in-R2 architecture locked (storage stays $0.25), knowledge raised to $0.60. Pro connections trimmed 300→150 (Yousef, 2026-07-24 — launch conservative; raising later is a gift, cutting is a change-policy event). Still open: calls-per-connection distribution (needs live traffic); Composio repricing 2026-08-15.
- Sizing of free-quota abuse exposure (Free-tier per-file caps, decay policy for idle Free orgs).
- Exact graduated-rate breakpoints.
- Stripe implementation scoping across `vendo` + `vendo-web` (meters exist partially: gateway dual-metering shipped; Stripe overage forwarding for llm_tokens was already flagged as remaining work in the cloud program).
