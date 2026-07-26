# Vendo Enterprise Commercial Paper Skeletons

Outline-level structures for the enterprise document set (MSA, SLA, DPA).
Section headings plus what each section must cover. No legal language here;
these are briefs for the attorney, grounded in public standard agreements.

**Grounding sources (verified 2026-07-24):**

- Common Paper Cloud Service Agreement v2.1 (the canonical open MSA-equivalent
  for SaaS; cover-page variables + 13 standard sections, CC BY):
  https://commonpaper.com/standards/cloud-service-agreement/2.1/ and
  https://github.com/CommonPaper/CSA
- Common Paper Service Level Agreement v2.0 (uptime + response-time credits,
  7-day claim window, 8%-of-fees credit cap, exclusions list):
  https://commonpaper.com/standards/service-level-agreement/2.0/
- Common Paper Data Processing Agreement v1.1 (roles, subprocessors, SCCs,
  deletion, audit rights, annexes):
  https://commonpaper.com/standards/data-processing-agreement/
- Secondary reference on SLA market norms (99.9% standard, tiered credit
  tables, 30-day claim windows, 50% monthly credit caps):
  https://termsbox.com/blog/saas-sla-uptime-template

Recommendation: adopt the Common Paper CSA + SLA + DPA as the base rather
than drafting from scratch. They are designed as a cover-page (variables) +
standard-terms split, which matches how Vendo wants to sell (one standard
paper, per-deal cover pages). The attorney's job is then mostly filling
variables and adding the Vendo-specific riders flagged below.

---

## 1. Master Service Agreement (MSA)

**DRAFT STRUCTURE — requires attorney review before any use.**

Modeled on Common Paper CSA v2.1. Structure: Cover Page (deal variables +
order form) incorporating Standard Terms by reference.

### Cover Page / Order Form
- Parties, effective date, subscription period, renewal mechanics.
- Fees: platform fee, usage commit, committed meter rates, Rung 2 add-on if
  applicable, payment terms (annual up front, net-30/60, quarterly true-up
  above commit, no hard-stop).
- Cover-page variables the attorney must define: General Cap Amount,
  Increased Cap Amount, Unlimited Claims list, governing law, chosen courts.
- Design-partner deals only: list price stated, named Year-1 Design Partner
  Discount line, consideration obligations (logo, case study, references)
  as contractual terms.

### Standard Terms sections
1. **The Service** - what Vendo provides: the Cloud services (console, orgs,
   gateway, store, broker, sandbox) and, where ordered, the Rung 2
   self-hosted distribution (containers, migrations, docs, quarterly update
   artifacts). Must distinguish Vendo-operated vs customer-operated
   components, and cover the OSS packages (Apache-2.0, governed by their own
   license, not this MSA).
2. **Restrictions and obligations** - acceptable use; customer responsibility
   for its own hosting/operation of Rung 2 components; no benchmarking
   clause decision; export.
3. **Privacy and security** - points to the DPA; prohibited data categories
   (decide: PHI? cardholder data?); security program description; breach
   notice commitment and timeline.
4. **Payment and taxes** - invoicing, true-up mechanics, late payment,
   disputes; explicit "no service gate for overage, protection is
   contractual" per pricing spec §5/§8.
5. **Term and termination** - term, renewal at list, termination for cause,
   effect of termination (data export window, deletion), survival.
6. **Representations and warranties** - mutual authority; Vendo service
   warranty (materially conforms to docs); compliance with law.
7. **Disclaimer of warranties** - standard disclaimers; explicit disclaimer
   for AI/agent output quality: generated UI and agent actions are
   probabilistic, customer configures guard rules and approvals.
8. **Limitation of liability** - FLAGGED, see below.
9. **Indemnification** - FLAGGED, see below.
10. **Confidentiality** - mutual; usage data and telemetry carve-outs
    (define what Vendo may collect from a Rung 2 deployment for metering).
11. **Reservation of rights / IP** - Vendo owns the platform; customer owns
    its data, its API, its end-user relationships; ownership of generated
    apps/UI produced by the agent inside customer's product (recommend:
    customer owns outputs); feedback license; no ML training on customer
    content without opt-in (Common Paper has a Machine Learning section -
    take a deliberate position, regulated ICP will read it first).
12. **General terms** - assignment, notices, publicity (default no logo
    rights unless the design-partner rider grants them), entire agreement.
13. **Definitions.**

### FLAG: Indemnification (Section 9) - needs real attorney design
This is the section enterprise buyers pay the $15k platform fee for. The
Vendo-specific problem: **the Vendo agent acts through the customer's own
API, authenticated as the customer's end-users.** Standard mutual-indemnity
language does not allocate this. The attorney must design:

- **Provider (Vendo) indemnifies customer for:**
  - Third-party IP infringement claims arising from the Vendo platform
    itself (standard), with the standard exclusions (combinations,
    customer-directed modifications) and remedies (procure rights, modify,
    refund and terminate).
  - Decide: data breach of Vendo-operated infrastructure - indemnity, or
    handled solely via liability cap + breach-notice obligations? (Market
    norm: super-cap, not unlimited indemnity.)
- **Customer indemnifies Vendo for:**
  - Customer content, customer's API and product, claims by customer's
    end-users arising from actions the agent took as those end-users within
    the permissions and guard rules customer configured.
- **The hard allocation questions to resolve explicitly:**
  1. Agent takes a wrong-but-authorized action as an end-user (e.g. money
     movement in a bank host): whose loss? Position: customer's, because
     customer defines the API surface, permissions, and guard rules; Vendo's
     liability limited to platform defects, capped.
  2. IP infringement in agent-generated UI/output: excluded from Vendo's IP
     indemnity or included? (Compare AI-vendor output-indemnity trend;
     decide deliberately, price accordingly.)
  3. Data breach on a Rung 2 deployment operated by the customer: Vendo
     responsible only for vulnerabilities in shipped artifacts, not for
     operation, patching cadence beyond quarterly artifacts, or the
     customer's infrastructure.
- Procedure: notice, sole control of defense, no settlement admitting fault
  without consent.

### FLAG: Limitation of liability (Section 8)
Adopt the Common Paper dual-cap pattern:
- **General cap:** fees paid/payable in the trailing 12 months (i.e. ~$30k+
  on a floor deal; on the design-partner deal, decide whether the cap keys
  off net fee ($15k) or list - attorney to advise, customer will notice).
- **Increased cap (super-cap):** 2-3x fees for breach of
  privacy/security/confidentiality obligations - this is where the data
  breach exposure lives.
- **Uncapped:** indemnification obligations (or a subset), willful
  misconduct, customer payment obligations.
- Mutual waiver of consequential damages, with the increased-claims
  carve-out.

---

## 2. Service Level Agreement (SLA)

**DRAFT STRUCTURE — requires attorney review before any use.**

Modeled on Common Paper SLA v2.0 plus market norms. Attaches via the Order
Form. Two regimes needed, because Rung 2 inverts who operates the service.

### 1. Scope and definitions
- Which services are covered: Vendo-operated Cloud services (gateway,
  console, hosted store, broker) get uptime; customer-operated Rung 2
  deployments get support/defect-fix commitments only, never uptime.
- Definitions: downtime, available minutes, scheduled maintenance,
  measurement source (Vendo's monitoring is authoritative; publish a status
  page).

### 2. Uptime commitment (Vendo-operated services)
- Target: 99.9% monthly (market standard; ~43 min/month). Do not promise
  99.99% at current maturity.
- Measurement: monthly, (available minutes - downtime minutes) / available
  minutes, per Common Paper method.
- Explicit carve-out: managed inference passthrough depends on upstream
  model providers; decide whether provider outages count as downtime
  (recommend: excluded, named as an exclusion).

### 3. Service credits
- Tiered credit table keyed to monthly uptime bands (e.g. <99.9%, <99.5%,
  <99.0% with rising credit percentages of that month's fees) - attorney/
  finance to set the bands.
- Credits are future-fee credits, not refunds; sole and exclusive remedy for
  availability misses.
- Claim procedure: customer claims within a fixed window (Common Paper: 7
  days after month end; market: up to 30 days - pick one).
- Annual cap on total credits (Common Paper: 8% of subscription-period fees;
  market alternative: monthly cap of 50% of monthly fees - pick one).

### 4. Exclusions
- Scheduled maintenance with advance notice (define notice window).
- Force majeure; general internet failures; third-party services outside
  Vendo's control (upstream model providers, Composio, customer's own
  Postgres/sandbox/model key on BYO paths).
- Customer-caused outages, unauthorized use, customer's Rung 2 operation.

### 5. Support tiers and response times
- Enterprise tier: named support engineer, private channel (Slack), and a
  severity matrix:
  - Sev 1 (production down / security incident): response target `[1 hr]`,
    24x7 or business-hours decision needed.
  - Sev 2 (major degradation): `[4 business hrs]`.
  - Sev 3 (minor / questions): `[1 business day]`.
- Response-time credits (Common Paper pattern) or no credits on response
  times - decide; automated acknowledgments do not count as response.
- Escalation path and status-page/incident-communication commitments.

### 6. Rung 2 support annex
- Quarterly update artifacts (images, migrations, notes); security-fix
  artifacts out-of-band for critical CVEs `[define target, e.g. 14 days]`.
- Defect fix process: reproduce on reference environment; customer provides
  logs/access; no on-call for customer-operated infrastructure.

---

## 3. Data Processing Agreement (DPA) basics

**DRAFT STRUCTURE — requires attorney review before any use.**

Modeled on Common Paper DPA v1.1. Controls over the MSA on conflict.
Required before any GDPR-governed personal data hits Vendo-operated services.
Note: on full-BYO and Rung 2 paths Vendo may process little or no end-user
personal data - the DPA's annexes must reflect the actual deployment shape.

1. **Roles and scope** - customer = controller (or processor for its own
   end-users), Vendo = processor/subprocessor. Map what personal data Vendo
   actually touches per component: gateway prompts/completions, hosted store
   records, broker tokens, thread/memory retention, telemetry from Rung 2.
2. **Processing instructions** - process only to provide the service and per
   documented instructions; explicit position on ML training (align with MSA
   Section 11 stance: no training on customer personal data).
3. **Subprocessors** - list current ones (model providers via gateway when
   managed inference is used, Cloudflare, Railway, Supabase, E2B, Composio,
   Stripe); notice period for changes (Common Paper: 10 business days) and
   customer objection right.
4. **Security measures (Annex)** - TOMs: encryption in transit/at rest,
   access controls, logging, incident response; honestly scoped to current
   posture (SOC 2 in progress, not claimable yet).
5. **Personal data breach notice** - notify without undue delay `[target
   hours: 48-72]` with details and cooperation.
6. **International transfers** - SCCs incorporated for EEA/UK data; UK
   addendum; transfer-impact posture.
7. **Data subject requests and assistance** - Vendo assists; requests
   arriving at Vendo get forwarded to customer.
8. **Deletion and return** - deletion on request during term; return or
   delete at termination within a defined window (align with MSA data-export
   window and retention tiers).
9. **Audit and reports** - annual right to security documentation/
   questionnaires; SOC 2 report access once issued (this is part of what the
   platform fee buys); on-site audits only where law requires, at customer
   cost.
10. **Liability** - subject to the MSA caps (or the increased cap), not a
    separate unlimited channel.
11. **Annexes** - parties, processing details (categories, purposes,
    duration), subprocessor list, TOMs.

---

## Open items for the attorney (consolidated)

1. Indemnity allocation for agent-as-end-user actions (MSA §9 flag) - the
   novel one; everything else is standard SaaS paper.
2. Output IP indemnity: in or out.
3. Cap amounts and what keys off net vs list on discounted deals.
4. Breach: indemnity vs super-cap.
5. ML/training clause position.
6. Credit schedule numbers and claim window.
7. Design-partner consideration enforcement mechanism (clawback vs
   renewal-at-list).
8. Rung 2 metering/true-up mechanics without Stripe (license file or
   reported usage) - needs a contract clause, engineering owns the mechanism.
