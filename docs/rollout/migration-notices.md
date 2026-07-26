> **GRANDFATHER NOTE (2026-07-24, supersedes any demotion implication below): existing orgs — however they signed up — keep FULL Free caps; the GitHub/Google signup gate and reduced lane ($1 credit / 50 sandbox min / 0.25 GB storage / 0.25 GB knowledge / 25 runs / 5 connections) apply to orgs created AFTER the enforcement flip only. Voice-pass email A accordingly.**

# Pricing Rollout — Migration Notices

**Status: DRAFT — Yousef voice-passes and sends every one of these. Nothing here goes out as-is.**
Source of truth: `docs/superpowers/specs/2026-07-24-usage-and-pricing-design.md` (§2 tiers, §5 enforcement, §7 change policy) and `docs/pricing/free-abuse-sizing.md` (idle decay, signup gate).

Placeholders to fill before send: `{{ENFORCEMENT_DATE}}` (must be ≥30 days out per §7 — the 30-day notice applies even at introduction), `{{REMINDER_DATE}}` (T-7), `{{PRICING_URL}}`, `{{BYO_DOCS_URL}}`, per-org usage numbers in email C.

---

## A. Existing Free orgs — the general notice

**To:** every Free org owner
**Subject:** Vendo Free is getting real limits on {{ENFORCEMENT_DATE}}

> DRAFT
>
> We're turning on usage enforcement for Free orgs on {{ENFORCEMENT_DATE}} — 30 days from this email.
>
> Until now the limits were on paper. From that date they're enforced at the service call. The Free allowances, monthly:
>
> - $5 of managed AI credit
> - 200 sandbox minutes
> - 1 GB storage, 1 GB knowledge base
> - 100 automation runs, 20 active connections
> - 7-day retention on threads, memory, and audit logs
>
> Hitting a cap hard-stops that service until your monthly reset. The error tells you the reset date and your two exits:
>
> 1. **Upgrade to Pro ($49/mo)** — bigger allowances, overage available.
> 2. **Bring your own keys** — your own model key, sandbox, Postgres, or Composio app. A BYO meter never ticks. Docs: {{BYO_DOCS_URL}}
>
> Two more things. Full Free caps now require GitHub or Google sign-in — email-only accounts get a reduced lane until they link one. And idle orgs decay: 21 idle days pauses services (warning at day 14), 90 days paused deletes data, with warnings before each step.
>
> Some orgs are currently well over these allowances. If that's you, you'll hear from us separately before anything stops.
>
> Full details: {{PRICING_URL}}. Questions — just reply.
>
> — Yousef

(~195 words)

---

## B. Existing paid customers — grandfathering notice

**Condition:** send only if any paid subscriptions exist at flip time (self-serve Pro/Teams). The design-partner enterprise deal is contract-governed and gets a personal note from Yousef, not this template. If there are zero paid subscribers, skip this email entirely.

**To:** every org with an active paid subscription
**Subject:** New Vendo pricing — your current terms don't change

> DRAFT
>
> We published new pricing today: {{PRICING_URL}}.
>
> Here's the part that matters for you: **you're grandfathered.** Your current price, allowances, and rates stay exactly as they are through the end of your current billing term. That's our standing policy — meter definitions never change, and any rate change comes with 30+ days notice and never mid-term.
>
> At your next renewal you move to the published plan for your tier. For most of you that means *larger* included allowances, plus new options: an overage toggle (off by default on Pro — nothing accrues unless you turn it on), a spend cap you control, volume-graduated rates, and optional usage bundles.
>
> Nothing you need to do. If the renewal numbers look worse for your specific usage shape, reply and we'll look at it together before your term ends.
>
> — Yousef

(~150 words)

---

## C. Targeted: orgs currently over the new Free limits

**To:** each Free org in the over-allowance triage pile, individually (e.g. the org currently ~247K tokens over the AI allowance). Personalize `{{USAGE_SUMMARY}}` with their actual numbers from the would-block report.
**Subject:** Heads up — your Vendo usage is over the new Free limits

> DRAFT
>
> Personal heads-up before the automated emails mean anything to you.
>
> On {{ENFORCEMENT_DATE}} we start enforcing Free-tier limits. Your org is currently well past them — last month: {{USAGE_SUMMARY}} (e.g. "$X of managed AI against the $5 credit"). Under enforcement, that usage would hard-stop partway through the month.
>
> You've clearly built something real on Vendo, and I don't want a quota flip to break it. So:
>
> - **You get 60 days, not 30.** Your org is exempt from enforcement until {{EXTENDED_DATE}}. No action needed for that.
> - **If you bring your own model key, the AI meter never ticks** — that alone likely takes you out of overage territory. I'll personally help you set it up; reply and we'll do it over a call or async.
> - **Or Pro is $49/mo** with a $10 credit and metered overage past it, at published passthrough+15% rates.
>
> Whichever way you go, nothing stops before {{EXTENDED_DATE}}, and you'll get warnings at 80% before anything ever blocks.
>
> What are you building? Genuinely curious.
>
> — Yousef

(~180 words)

---

## Send order

1. T-30: email C to the triage pile first (same day, before A, so heavy users hear it personally before the blast).
2. T-30: email A to all remaining Free orgs; email B to paid orgs if any.
3. T-7: short reminder variant of A/C (see `enforcement-flip-runbook.md` timeline).
