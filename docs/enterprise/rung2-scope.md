# Rung 2 Scope — Vendo Cloud on Customer Infrastructure

Status: draft, 2026-07-24
Sources: on-prem deal assessment + vendo-web portability scoping (2026-07-23), usage-and-pricing design §8.

---

## 1. What Rung 2 is

Rung 2 means the **cloud half of Vendo runs inside the customer's own infrastructure** (their VPC / their Kubernetes), operated by their team, while Vendo ships the software as versioned container images, database migrations, and runbooks. The OSS half (the `@vendoai/*` packages embedded in the customer's product) is unchanged — it simply points at their private Vendo Cloud instead of ours.

The three rungs, for orientation:

| Rung | Shape | Band |
|---|---|---|
| 1 | Self-hosted OSS + support (the default deployment model already) | Band 1 |
| **2** | **Cloud half in the customer's VPC, customer-operated, Vendo-shipped** | **Band 2 (+$30k/yr minimum add-on)** |
| 3 | True air-gap, dedicated everything | Band 3 ($120k+) |

### What Rung 2 is NOT

- **Not air-gapped.** The deployment requires outbound network egress: to Anthropic (or the customer's Bedrock/Azure endpoint) for inference, and to Vendo for usage reporting and update artifacts. A no-egress environment is Rung 3 / Band 3 and is out of scope here.
- **Not Vendo-operated.** We do not hold credentials to, page for, or SSH into the customer's environment. Their platform team runs it.
- **Not per-release.** The customer receives **quarterly update artifacts**, not every release. Continuous tracking of main is explicitly excluded.
- **Not multi-environment.** One production environment. Staging/DR replicas are the customer's copies of the same artifacts, unsupported beyond documentation.
- **Not custom-featured.** Same codebase as hosted Cloud, configuration-differentiated only. No forks, no customer-specific patches.

---

## 2. Component inventory

### Moves to customer infrastructure

| Component | What it is today | Rung 2 form |
|---|---|---|
| Console app (`apps/console`) | Next.js console, OpenNext on Cloudflare Workers | `next start` in a container |
| Broker service (`services/broker`) | Connections/actions broker, already Dockerized (Railway) | Same container, their cluster |
| Inference gateway (`services/litellm`) | LiteLLM, already Dockerized | Same container; routes to their Bedrock/Azure or direct Anthropic |
| Machine-proxy worker (`workers/machine-proxy`) | Cloudflare Worker reverse proxy | Plain reverse-proxy container |
| Sandbox backend | E2B via the `BrokerBackend` seam | New Docker-based backend running on their cluster |
| Auth/identity | Supabase (hosted) | Self-hosted Supabase (official compose), SAML to their IdP |
| Databases | Supabase Postgres + Neon-provisioned per-org DBs | Their Postgres; per-org provisioning becomes schemas in their instance |
| Object storage | Cloudflare R2 | MinIO or their S3-compatible store |
| Queues / crons | Cloudflare Queues + crons | Postgres-backed queue + standard schedulers |

### Stays with Vendo (hosted)

- **Stripe / commercial billing.** Stripe never runs in their VPC; billing is contract + true-up invoicing driven by usage reports (see §6).
- **Usage aggregation and the billing ledger** that receives their reported meter counts.
- **The public registry, docs, npm packages, and update-artifact distribution** (registry access is normal outbound HTTPS).
- **Our multi-tenant Cloud** for every other customer — Rung 2 is a private *instance*, not a private *fork*.

---

## 3. Portability work items (~4–6 weeks total)

From the completed scoping of vendo-web (origin/main, 2026-07-23):

| Item | Finding | Effort |
|---|---|---|
| Broker + gateway | Already Dockerized; portable as-is | ~0 |
| Console off Cloudflare | CF-specific surface (R2, Queues, crons) is centralized in ~7 files (env, blob, and automations-worker layers) → next-start-in-Docker + MinIO + Postgres queue | ~1–2 wk |
| Sandbox Docker backend | Sandbox already behind the `BrokerBackend` seam (E2B + fake backends exist); write a Docker backend. Firecracker-grade isolation (self-hosting E2B) is **out of v1** | ~1–2 wk |
| Supabase → self-hosted | Official self-hosted compose; migrations already in repo; SAML for their IdP | ~1 wk |
| Machine-proxy → reverse proxy | Straightforward replacement | days |
| Neon → their Postgres | Provisioning is env-gated; becomes schema-per-org in their instance | days |
| Stripe stub | Stripe usage confined to billing/stripe modules; stub behind the license + usage-report path | days |

Plus a **permanent release tax**: every future change to the CF/Supabase/Stripe surfaces must keep the container path working. This tax — not the one-time 4–6 weeks — is the main cost of Rung 2 and the core of the pricing rationale (§7).

---

## 4. Operational and support model

- **Customer operates; Vendo ships.** Their platform team deploys, upgrades, backs up, and monitors. We deliver quarterly artifact bundles: pinned container images, ordered DB migrations, config/change notes, and an upgrade runbook.
- **Paging:** their on-call is paged for their instance. Vendo provides named-support escalation during business hours per the enterprise SLA; we debug from logs and reproductions they send, not from live access.
- **Security patches** are the one exception to quarterly cadence: critical CVEs in shipped images get an out-of-band artifact.
- **Telemetry home (required, contractual):**
  - Aggregated meter counts must reach Vendo (see §6). This is a condition of license, not optional.
  - Operational telemetry (errors, versions-in-the-wild) is strongly requested for supportability; exact scope negotiable, but a support case without version/health data gets best-effort treatment only.
  - No host end-user content or payloads ever leave their VPC — reports are counts and identifiers, consistent with our "never billed: end-user counts" rule (counts reported are the six meters only).
- **Upgrade obligation:** customer must be within N-1 quarterly releases to retain SLA support. Running stale versions moves them to best-effort.

---

## 5. Prerequisites we require from the customer

- **Kubernetes or equivalent** container platform (compose acceptable only if we agree before signing — pin down which; see open questions).
- **Postgres** they own and operate (backups, HA, sizing) — this is the hard-BYO path doing its job.
- **S3-compatible object storage** (MinIO acceptable) for files/blobs.
- **Network egress** to: Anthropic API *or* their own Bedrock/Azure endpoint (inference), Vendo usage-reporting endpoint, npm/registry, and the artifact distribution channel.
- **BYO model key** (their Anthropic key or Bedrock credentials) — managed inference through our gateway billing is not part of Rung 2 v1.
- **An IdP that speaks SAML/OIDC** for console SSO.
- **A named platform owner** on their side who receives artifacts, runs upgrades, and is our single operational counterpart.

---

## 6. Metering and billing in a Rung 2 deployment

The **key + meter model survives unchanged** — that is a design requirement, not an accident:

- The private instance is provisioned with the customer's enterprise **Vendo key**, exactly like hosted Cloud. Gating remains "valid key + meter," no capability booleans, no entitlement protocol.
- Every metered service in their VPC (gateway, sandbox, store, broker, automation scheduler) counts usage against the six meters locally, and the instance **reports aggregated meter counts home** to Vendo on a regular cadence. Counts only — no payloads, no end-user data.
- Vendo's hosted billing ledger receives the reports and drives the **enterprise commit + quarterly true-up**: billed "greater of floor or actual," per §8 of the pricing design. Stripe stays on our side; they see an invoice, never a card.
- **Enterprise never hard-stops** — meter exhaustion in their instance is a true-up line, not a service gate. Protection is contractual.
- Sustained failure to report (beyond a grace window) is a **contract breach handled commercially**, not a kill switch. We do not ship remote-disable logic; key problems surface on the first real service call, same as everywhere else.
- BYO offsets apply as normal: their model key zeroes the AI meter, their Postgres zeroes storage. In practice Rung 2 usage revenue concentrates in automation runs, connections, and sandbox minutes.

---

## 7. Pricing rationale: +$30k/yr minimum add-on (on top of Band 1)

Rung 2 lists at **Band 1 (effective floor $30k: $15k platform fee + $15k minimum commit) plus a +$30k/yr Rung 2 add-on → $60k+ list**, landing it in Band 2 ($60–90k). The add-on is justified by three things:

1. **Permanent portability maintenance.** After the one-time 4–6 week packaging, every release forever must keep the container path (console-in-Docker, self-hosted Supabase, Postgres queue, Docker sandbox backend, Stripe stub) green alongside the CF/Railway/Supabase/Stripe path. That is a recurring engineering tax with no hosted-side benefit.
2. **Support burden asymmetry.** Debugging software we don't operate — across their K8s flavor, their Postgres, their network policies — is categorically more expensive than debugging our own fleet, even with the customer holding the pager.
3. **Band-2 anchoring.** The add-on is the concrete thing that makes Band 2 real. If Rung 2 were absorbed into Band 1 pricing, deployment control becomes free and the band structure collapses; every future regulated-ICP deal would negotiate from the collapsed number.

**Design-partner exception (the current $15k deal):** survivable only under the locked policy — order form shows **list price ($60k+ per this structure; $75k was the figure quoted in the original assessment) with a named Year-1 design-partner discount line**, 1-year term, renewal at list or renegotiation, contractual consideration (logo, case study, references), a one-time implementation fee if attainable, and the fences in this document (single environment, quarterly artifacts, customer-operated, BYO key + Postgres, no air-gap). Capped at 1–2 such deals ever. At $15k Rung 2 is negative-margin year one; it only pencils because the packaging work serves the regulated-ICP roadmap and renewal repricing is contractually anchored.

---

## 8. Open questions

1. **Customer identity and deal status** — who is the customer, and is the $15k verbal or signed? (Not recorded in the deal memory.)
2. **List-price anchor** — has the order form with the list price + named design-partner discount actually been sent? (Precondition before any engineering starts.)
3. **Sandbox isolation requirement** — is Docker-level isolation acceptable for their threat model? Firecracker-grade (self-hosted E2B) is out of v1; if they require it, scope and price change materially. Must be pinned before signing.
4. **K8s vs compose mandate** — which platform do they actually run? Determines packaging target and runbook shape. Must be pinned before signing.
5. **Inference route** — direct Anthropic egress or their Bedrock/Azure? Affects gateway config and their security review.
6. **Usage-report cadence and transport** — how often do meter counts report home, and does their security team need to approve the payload schema?
7. ~~Reconciling the list-price figures~~ **RESOLVED (Yousef, 2026-07-24): $60k — the band math — goes on the order form.** Defensible arithmetic the customer can verify against the published structure; the discount line shows −$45k.
8. **One-time implementation fee** — is the ~$10–25k professional-services onboarding fee attainable in this deal?
9. **Operational telemetry scope** — beyond mandatory meter counts, what error/version telemetry will they accept?
10. **Supabase self-hosted ownership** — confirming their team operates the self-hosted Supabase stack (auth is on the critical path; it should sit with whoever owns their Postgres).
