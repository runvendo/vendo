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
| **Multi-party surfaces** | None | Snapshot share links, live collab apps, publishing; basic console (usage, keys, deployments) | + Org layer (overlay, org principals, registry + promotion, pinning/host-adoption); full governance console (guard hot-edit, batch approvals, session replay, org activity, insights); SAML SSO (no SSO tax) | + SCIM, custom RBAC, multi-org/subsidiaries |
| **AI credit (managed inference)** | $5/mo, hard stop | $10/mo, then passthrough +15% | $50/mo, then passthrough +10% | Committed rates |
| **Sandbox minutes** | 200, hard cap | 2,000 incl., then $0.01/min | 10,000 incl., cheaper overage | Committed |
| **Storage GB-mo (data + knowledge + threads + memory)** | 1 GB, hard cap | 20 GB incl., then $0.25/GB-mo | 100 GB incl., cheaper overage | Committed |
| **Automation runs** | 100/mo, hard cap | 3,000/mo incl., then $3/1k | 30,000/mo incl., cheaper overage | Committed |
| **Active connections** | 20, hard cap | 300 incl., then ~$0.30/conn-mo | 2,000 incl., cheaper overage | Committed |
| **Thread/session retention** | 7 days | 90 days | Unlimited; 1-yr audit-log retention | Custom / compliance-grade |
| **Support** | Community | Email | Priority | Named SE, private channel, SLA |

All allowance and overage numbers are structural placeholders **pending COGS validation against real usage data** before the pricing page ships. The structure (which meters exist, hard-stop vs overage, ratios between tiers) is the locked part.

## 3. The five meters

A meter exists only where Cloud carries real marginal COGS *and* a BYO escape hatch exists. Everything else is tier contents, not usage.

1. **Managed AI (tokens)** — provider passthrough +15% (Pro) / +10% (Teams), dual-metered at the gateway. BYO model key → $0. Public rate sheet; "passthrough" must stay verifiable. Never called a "gateway" in marketing — it is *managed inference* (gateways charge 0%; workflow-embedded resale sustains 10–20%: Zed +10%, Cursor ~+20%).
2. **Sandbox minutes** — includes app-build compute. BYO E2B/own sandbox → $0.
3. **Storage GB-month** — one number covering hosted-store data, threads/sessions, knowledge base (docs + vectors), and memory. Knowledge ingestion (parse/OCR/embed, ~$0.50–5/GB one-time) is absorbed into the recurring GB rate; retrieval is free (rounding error vs. the generation call). Guardrails, not meters: per-file upload cap on Free; pathological OCR-farm cases go to contract terms. BYO Postgres/RAG → $0.
4. **Automation runs** — a hosted automation execution (scheduled/triggered). **Interactive chat is never a run** (no double-metering a conversation that already pays the AI meter).
5. **Active connections** — a user × integration pair (Sarah's Gmail = 1, her Slack = a 2nd) that performed ≥1 broker-mediated action in the calendar month. Automation-initiated actions count (real Composio COGS); token refreshes, health checks, connect/disconnect events, and dormant stored credentials do not. Console shows exactly which connections counted and why. Fair-use clause on per-connection call volume backstops the loose calls↔connections correlation (our vendor COGS is per tool call, ~$0.11/1k). BYO Composio key / host-side OAuth → $0.

**Mapping rule (locked):** new services must map onto existing meters — knowledge/memory → storage + AI tokens; app builds → sandbox minutes. The meter set stays at five. **The meter unit definitions are permanent** — every 2025–26 repricing disaster (Cursor, Copilot, v0) was a mid-flight unit redefinition; we never redefine, only re-rate with grandfathering (§7).

## 4. Bundled AI credits

$5 Free / $10 Pro / $50 Teams per month. Dollar-denominated, no rollover, netted on the invoice.

- Sized to the **Supabase pattern** (credit covers the default/eval footprint), not the Cursor pattern (~100% of plan price): ~$0.05/chat turn and ~$1–2/app build on Sonnet-class models → Free ≈ 100 turns (the README demo + tinkering), Pro ≈ 200 turns/mo (the developer building), Teams ≈ 1,000 turns/mo (a team building or tiny pilot).
- **Marketing rule:** credits are "enough to build and try it" — never "AI included." They intentionally cannot cover end-user production traffic (100 end-users × 10 turns ≈ $50/mo).
- The AI meter is an on-ramp, not a profit center: at +15%, margin is thin by design; plan fees and the infra meters are the revenue lines.

## 5. Enforcement (what "meter exhausted" means)

Enforcement is server-side at service-call time — gateway, sandbox, store, broker, automation scheduler each check `valid key + meter not exhausted` before doing work. No client-side checks. ~5% internal tolerance absorbs async metering lag.

- **Free: hard stop** at 100% of any cap, with a developer-readable error naming the reset date and the two exits (upgrade / BYO). Warning email at 80%. No card, ever.
- **Pro/Teams: overage requires explicit opt-in** (toggle default **off** on Pro, **on** on Teams). Toggle off → Free-style hard stop at allowance with an enable prompt showing the rates. Toggle on → silent metered accrual under a **customer spend cap** (default on at 2× plan price, one-click adjustable); at cap, hard-stop behavior. Notifications at 50/80/100% of allowances and cap.
- **Degrade asymmetry:** inference/sandbox/storage stop instantly at a cap; automations and connections fail *loudly* (run marked "blocked by spend cap" in console + owner email) — never silently unfired.
- **Enterprise never hard-stops.** Overage is a true-up invoice line, not a service gate; protection is contractual.

## 6. Billing mechanics

Stripe subscription + five metered prices + billing thresholds + one opt-in toggle. No prepaid wallet, no credit packs.

- **Monthly invoice** = plan fee + per-meter overage lines (credits netted), on the subscription card. Line items are the five meters at public rates — the bill self-documents.
- **Mid-cycle settlement threshold (our exposure control):** when accrued overage crosses max($100, 1× plan price), Stripe invoices and charges immediately; tab resets. Bounds our bad-debt exposure per customer to ~one threshold and surfaces runaway usage to the customer within days, not at month-end.
- **Spend cap (their control)** sits on top, per §5.
- **Failed payment:** Stripe dunning → 7–14 day grace with warnings → meters flip to hard-stop; no new debt accrues past the flip.
- **Annual self-serve:** offered at ~2 months free.
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

- **Usage bundles** (recurring "commit to $X/mo usage for 10–15% off, overflow metered") — purely additive later; adds SKU/rollover complexity now.
- Marketplace/registry monetization; multi-region self-serve; per-region pricing.

## 10. Open items before the pricing page ships

- Validate every allowance/overage number against real COGS + usage data (meter rates in §2–3 are structural placeholders).
- Sizing of free-quota abuse exposure (Free-tier per-file caps, decay policy for idle Free orgs).
- Exact graduated-rate breakpoints.
- Stripe implementation scoping across `vendo` + `vendo-web` (meters exist partially: gateway dual-metering shipped; Stripe overage forwarding for llm_tokens was already flagged as remaining work in the cloud program).
