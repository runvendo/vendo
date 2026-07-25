# Vendo Design Partner Term Sheet (Year 1)

**INTERNAL DRAFT.** Non-binding summary of proposed commercial terms. Final terms
live in the MSA, Order Form, SLA, and DPA. Requires attorney review before sending.

Prepared: 2026-07-24. Prepared by: Yousef Hilal, Vendo (vendo.run).

---

## 1. Parties

- **Provider:** Vendo, Inc. `[confirm legal entity name]`
- **Customer:** `[CUSTOMER LEGAL NAME]` ("Design Partner")

## 2. Deal summary

Customer receives a Rung 2 deployment of Vendo: the Vendo Cloud control plane
(console, orgs, SSO, sharing, hosted store, model gateway) runs on Customer's
own infrastructure, operated by Customer's team, with the Vendo OSS packages
embedded in Customer's product as usual. Year 1 is priced as a one-time,
named Design Partner exception to list price, in exchange for the
consideration in Section 5.

## 3. Pricing

| Line item | Annual list price |
|---|---|
| Vendo Enterprise platform fee (MSA, SLA, SSO/SCIM, compliance paper, audit retention, named support) | $15,000 |
| Minimum usage commit (metered usage at committed rates, quarterly true-up above commit) | $15,000 |
| Rung 2 deployment add-on (Cloud control plane on Customer infrastructure) | $30,000 |
| **Total list price** | **$60,000 / yr** |
| **Year-1 Design Partner Discount** (one-time, Year 1 only, non-recurring) | **($45,000)** |
| **Year-1 net fee** | **$15,000 / yr** |
| One-time implementation fee (deployment packaging, onboarding; professional services, invoiced separately) | $`[10,000-25,000 — push to include]` |

Notes:

- The platform fee is never discounted at Vendo; the Design Partner Discount
  is applied at the total-deal level as a single named exception line. The
  order form must show list price and the discount explicitly. `[If quoting
  the top of Band 2, list can be stated up to $75-90k; $60k is the floor
  computation. Pick one number and keep it on every document.]`
- Usage above the commit is invoiced quarterly at committed meter rates
  (true-up). Service is never hard-stopped for overage.

## 4. Term, payment, renewal

- **Term:** 12 months from the Effective Date. No auto-renewal at Year-1 pricing.
- **Payment:** annual, invoiced up front, net `[30/60]`. No credit card.
- **Renewal:** at then-current list price, or as renegotiated in good faith no
  later than 90 days before expiration. The Year-1 Design Partner Discount
  does not carry into any renewal term and is not a reference price.
- Multi-year renewal, if elected, carries a 5-10%/yr escalator.

## 5. Design Partner consideration (required, contractual)

In exchange for the Year-1 Design Partner Discount, Customer agrees to:

1. **Logo rights:** Vendo may display Customer's name and logo on its website
   and sales materials as a customer.
2. **Public case study:** one jointly approved written case study, published
   within `[6]` months of go-live. Customer will not unreasonably withhold approval.
3. **Reference calls:** up to 3 reference calls with prospective Vendo
   customers during the Term, scheduled with reasonable notice.
4. **Product feedback:** `[optional: quarterly feedback session with Vendo
   product team]`.

If the consideration in items 1-3 is not provided, `[remedy: discount clawback
/ renewal-at-list becomes automatic - attorney to structure]`.

## 6. What is included

- **Rung 2 deployment:** private distribution of the Vendo Cloud control plane
  (console, org layer, SSO, sharing/registry, hosted store, model gateway)
  packaged for Customer's infrastructure. Vendo ships containers, database
  migrations, and deployment docs.
- **Single environment** (one production deployment). Additional environments
  are out of scope and separately priced.
- **Customer operates it:** Customer's team runs the deployment (hosting,
  monitoring, backups, network). Vendo provides artifacts and support, not
  managed operations.
- **Quarterly update artifacts:** Vendo delivers updated container images,
  migrations, and release notes on a quarterly cadence. Not per-release.
- **BYO dependencies:** Customer provides its own Postgres and its own model
  provider key (e.g. Bedrock/Azure via the gateway). Inference and database
  costs are Customer's.
- **SLA:** support SLA per the attached SLA (response times, named support
  engineer, private channel). Note: uptime credits apply only to
  Vendo-operated services; for the customer-operated Rung 2 deployment the
  SLA covers support responsiveness and defect-fix targets, not uptime.
- **Usage commit:** $15k of committed usage at discounted meter rates,
  measured by the deployment's built-in metering. `[Confirm license-file /
  reported-metering mechanics before signature - Stripe metering does not
  apply on-prem.]`
- **Onboarding / implementation services** per the implementation fee line.

## 7. Expressly not included

- **SOC 2 report:** SOC 2 is in progress at Vendo and no report is available
  during Year 1. `[Optional: commit to sharing the report when issued.]`
- **Air-gapped deployment.** The deployment assumes outbound internet access.
- **Per-release updates** or any update cadence faster than quarterly.
- **Managed operations, hosting, or on-call** for Customer's deployment.
- **Multi-region, HA beyond single-environment defaults, or additional
  environments.**
- **Custom development** beyond the scoped deployment packaging (separately
  scoped and priced as professional services).
- **Firecracker-grade sandbox self-hosting:** the sandbox backend ships as
  the standard Docker backend; self-hosted E2B-grade isolation is out of
  scope for Year 1.

## 8. Delivery and conditions

- **No deployment date is committed in this term sheet.** A delivery schedule
  is set at technical kickoff after signature. Internal scoping estimate:
  ~4-6 weeks of packaging work.
- To be pinned down **before signature** (blocking):
  1. Customer's sandbox isolation requirement (Docker-level acceptable?).
  2. Kubernetes vs docker-compose mandate for the deployment target.
  3. Customer's IdP for SSO (SAML assumed).
- Design Partner deals are capped at 1-2 ever; this pricing is not available
  to other customers and is not precedent for renewal.

## 9. Next steps

1. Customer confirms Section 8 items.
2. Vendo sends order form (list price + discount line, mirroring Section 3),
   MSA, SLA, DPA.
3. Signature, invoice, technical kickoff.

---

*This term sheet is for discussion only and creates no binding obligations
except `[confidentiality, if desired]`. All terms subject to definitive
agreements reviewed by counsel.*
