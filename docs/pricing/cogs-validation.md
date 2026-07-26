# COGS Validation — Usage & Pricing v3 Meters

**Date:** 2026-07-24
**Scope:** Validates the six placeholder meter rates in `docs/superpowers/specs/2026-07-24-usage-and-pricing-design.md` §2–3 against current vendor pricing. No internal usage data was available — §5 flags what still needs it.

## Vendor rate sheet (verified 2026-07-24)

| Vendor | What we buy | Rate | Source |
|---|---|---|---|
| Anthropic | Sonnet 5 | $3 in / $15 out per MTok (intro $2/$10 through 2026-08-31) | [platform.claude.com/docs/en/pricing](https://platform.claude.com/docs/en/pricing) |
| Anthropic | Haiku 4.5 | $1 in / $5 out per MTok | same |
| Anthropic | Opus 4.8 | $5 in / $25 out per MTok | same |
| E2B | Sandbox compute | $0.000014/vCPU-s + $0.0000045/GiB-s RAM; default 2 vCPU ≈ $0.10/hr; Pro plan $150/mo fixed | [e2b.dev/pricing](https://e2b.dev/pricing) |
| Cloudflare Containers | Sandbox alternative | $0.000020/vCPU-s + $0.0000025/GiB-s + $0.00000007/GB-s disk (+$5/mo Workers Paid) | [developers.cloudflare.com/containers/pricing](https://developers.cloudflare.com/containers/pricing/) |
| Neon | Per-project Postgres | **Storage $0.35/GB-mo** (Launch & Scale); compute $0.106/CU-hr (Launch); instant-restore/WAL history $0.20/GB-mo; no monthly minimum | [neon.com/pricing](https://neon.com/pricing) |
| Cloudflare R2 | Object storage | $0.015/GB-mo standard ($0.01 IA); Class A $4.50/M, Class B $0.36/M; zero egress | [developers.cloudflare.com/r2/pricing](https://developers.cloudflare.com/r2/pricing/) |
| Composio | Broker tool calls | $229/mo "Serious Business" = 2M calls (**$0.1145/1k** effective, ~matches spec's ~$0.11/1k); overage $0.249/1k; ⚠️ page says "pricing will be changing on August 15th" | [composio.dev/pricing](https://composio.dev/pricing) |

---

## 1. Per-meter validation

### Meter 1 — Managed AI (passthrough +15%)

| | |
|---|---|
| Vendor cost | Anthropic list rates (above); dual-metered at gateway, so caching/batch savings pass through symmetrically |
| Our rate | provider passthrough +15% |
| Gross margin | **13% of revenue (15/115) by construction** — independent of model mix |
| Verdict | **KEEP.** Margin is structural, not a number to validate. Sonnet 5 intro pricing ($2/$10 through 2026-08-31) means the flagship `vendo` row launched at intro-equivalence gets a silent margin bump when intro pricing ends only if the published rate was set at the $3/$15 sticker — confirm which base was used before printing the rate sheet. |

Settled by vendor pricing alone. The vendo-* family rows add routing margin on top (e.g. `vendo-judge` on Haiku-class at a Sonnet-anchored gap) — that's upside, not risk.

### Meter 2 — Sandbox minutes ($0.01/min)

Per-minute vendor cost at realistic shapes:

| Provider / shape | $/min | Margin at $0.01/min |
|---|---|---|
| E2B 2 vCPU + 1 GiB | $0.00195 | 80% |
| E2B 2 vCPU + 4 GiB | $0.00276 | **72%** |
| E2B 4 vCPU + 8 GiB | $0.00552 | 45% |
| CF Containers "basic" (¼ vCPU, 1 GiB) | $0.00045 | 95% |
| CF Containers "standard" (½ vCPU, 4 GiB) | $0.00120 | 88% |

| | |
|---|---|
| Verdict | **KEEP $0.01/min.** ~72–80% gross margin on the default E2B shape; Cloudflare Containers is a cheaper fallback for light workloads. Margin only breaks if we hand out ≥4 vCPU shapes at the same rate — if larger shapes ship, meter them at a multiplier (e.g. 2× minutes for 4 vCPU), never a new unit. |
| Riders | E2B Pro $150/mo is fixed COGS amortized across all orgs (noise at any scale). Billing definition matters: metered minutes must be sandbox *lifetime* (we pay E2B for idle wall-clock too), or idle timeout must be aggressive. |

Rate is settled by vendor pricing; **minutes-per-app-build and idle policy need usage data** (affects allowance sizing, not the rate).

### Meter 3 — Storage, files & app data ($0.25/GB-mo)

The one underwater placeholder as literally spec'd:

| Backing | Vendor $/GB-mo | Margin at $0.25 |
|---|---|---|
| Neon (per-project Postgres) | $0.35 (+$0.20/GB-mo WAL/instant-restore history) | **−40% to −120%** |
| R2 standard | $0.015 | +94% |
| Blended: file bytes in R2, records/documents in Neon (assume 60/40 by GB) | ≈ $0.15 | +40% |

| | |
|---|---|
| Verdict | **CHANGE — one of two fixes.** (a) *Preferred:* architect the split — file/attachment bytes go to R2, only rows/app documents live in Neon — then **keep $0.25** with ~30–60% blended margin. (b) If everything stays in Neon-backed hosted store, **raise to $0.45/GB-mo** (28% margin over $0.35 vendor, before WAL rider). Do not ship $0.25 on all-Neon. |
| Riders | Neon compute ($0.106/CU-hr) is **unmetered COGS** — an active hosted-store project burns CU-hours no meter captures (~$0.50/mo per moderately active project; scale-to-zero bounds idle projects). Fine at current rates; watch it in margin reviews. WAL history $0.20/GB-mo: keep restore windows short on Free/Pro. |

Rate decision is settled by vendor pricing; the **file-vs-row GB mix needs usage data** to confirm the blended margin under option (a).

### Meter 4 — Knowledge base ($0.35/GB-mo)

Cost per source-GB has three parts (1 GB text ≈ 250M tokens ≈ ~500k 512-token chunks):

| Component | Range | Notes |
|---|---|---|
| Doc bytes (R2) | $0.015/GB-mo | negligible |
| Vectors | $0.26–1.02/GB-mo in Neon/pgvector | 768-dim halfvec ≈ 0.7 GB vectors/source-GB → $0.26; 1536-dim float32 ≈ 2.9 GB → $1.02 |
| One-time ingestion (parse/OCR/embed) | $0.50–5.00/GB | e.g. text-embedding-small-class ≈ $5/GB at $0.02/MTok; amortized over 12 mo ≈ $0.04–0.42/GB-mo |

Realistic ongoing COGS: **$0.30–0.45/GB-mo** with a tuned stack (quantized 768-dim vectors, cheap embeddings); $0.55–1.45 with a naive stack (float32 1536-dim in Neon).

| | |
|---|---|
| Verdict | **CHANGE — raise to $0.60/GB-mo** (or $0.50 if storage stays at $0.25 and the premium narrative needs to stay "small"). At $0.35 the margin is ≈0% best-case and negative otherwise. $0.60 gives ~35–50% margin on the tuned stack and still absorbs amortized ingestion. Alternatively keep $0.35 *only if* vectors are stored quantized on cheap storage (R2/self-hosted RAGFlow disk), not in Neon at $0.35/GB — that's an architecture commitment, price it after the knowledge-stack spec lands. |

**Needs usage data / a stack decision:** vector-to-source ratio (embedding model + quantization) and real OCR incidence dominate this meter's cost.

### Meter 5 — Automation runs ($3/1k = $0.003/run)

| Run profile | COGS/run | Margin at $0.003 |
|---|---|---|
| Pure orchestration (queue + Workers invocation, broker calls billed to connections, AI billed to AI meter) | ~$0.0001–0.0005 | 83–97% |
| Runs averaging ~30s light compute | ~$0.001 | 67% |
| Runs that spin a sandbox (should bill sandbox meter instead) | $0.003+/min | n/a — must ride Meter 2 |

| | |
|---|---|
| Verdict | **KEEP $3/1k.** Healthy margin as long as the mapping rule holds: a run's inference bills the AI meter, its broker calls ride connection COGS, and any sandbox time bills sandbox minutes. The run fee prices scheduling/execution overhead only. |

Settled by vendor pricing; **average run compute profile needs usage data** for allowance sizing only.

### Meter 6 — Active connections (~$0.30/conn-mo)

COGS is purely call-volume driven: $0.1145/1k calls included-rate ($0.249/1k in overage). $0.30 buys ~2,600 calls at included rate (~1,200 at overage rate).

| Avg broker calls / connection / month | COGS/conn-mo | Margin at $0.30 |
|---|---|---|
| 100 | $0.011 | 96% |
| 500 | $0.057 | 81% |
| 1,000 | $0.115 | 62% |
| 2,600 | $0.30 | 0% |

| | |
|---|---|
| Verdict | **KEEP ~$0.30/conn-mo, contingent.** Margin is fine up to ~1k calls/conn/mo; the spec's fair-use clause is load-bearing — it must be enforceable (per-connection call counting already exists for the console view). Two watch items: (1) **Composio reprices 2026-08-15** — re-verify before the pricing page ships; (2) the $229/mo platform fee is fixed COGS until volume amortizes it (needs ~750 billed connections to cover on its own — fine, plan fees carry it early). |

**Needs usage data:** the calls-per-connection distribution is the single most margin-sensitive unknown in the whole model.

---

## 2. Allowance sanity checks

### Free org at all caps (target ≤ ~$10/mo)

| Line | Worst case | Steady state |
|---|---|---|
| $5 AI credit fully burned | $4.35 (provider cost at +15% netting) | $4.35 |
| 200 sandbox min (E2B 2 vCPU/4 GiB) | $0.55 | $0.55 |
| 1 GB storage (all-Neon + WAL) | $0.55 | $0.35 |
| 1 GB knowledge | **$5.50** (incl. up to $5 first-month ingestion) | $0.50 |
| 100 runs | $0.30 | $0.10 |
| 20 connections (worst: 1k calls each = 20k calls) | $2.29 | $0.25 (typical ~100 calls each) |
| Neon compute rider | $0.50 | $0.50 |
| **Total** | **≈ $14.0 (first month)** | **≈ $6.6–9.0** |

**Verdict: steady-state passes (<$10); worst-case first month fails (~$14), driven almost entirely by knowledge ingestion.** Mitigation already in the spec (Free per-file upload cap) — additionally cap Free knowledge *ingestion* (e.g. OCR excluded on Free, or 250 MB/mo ingest cap) and the worst case drops to ~$9–10. Note this is the at-all-caps org; the expected Free org costs cents to low dollars.

### Pro org at all allowances (target ≤ ~$25/mo, plan fee $49)

| Line | Typical at-cap | Heavy at-cap |
|---|---|---|
| $10 AI credit burned | $8.70 | $8.70 |
| 2,000 sandbox min | $5.52 | $5.52 |
| 20 GB storage | $2.00 (R2 split) | $7.00–11.00 (all-Neon + WAL) |
| 10 GB knowledge | $3.50 | $5.00+ |
| 3,000 runs | $3.00 | $9.00 |
| 300 connections | $6.90 (~200 calls each) | $34.40 (1k calls each) |
| Neon compute rider | $2.00 | $4.00 |
| **Total** | **≈ $31.6** | **≈ $77.6** |

**Verdict: fails the $25 target even in the typical case (~$32, i.e. ~65% of the $49 fee), and the heavy case exceeds the plan fee.** Three levers, in order of impact:
1. **Storage split to R2** (fix from Meter 3) — already assumed in "typical"; mandatory.
2. **Trim included connections 300 → 150** (typical at-cap drops ~$3.50; heavy drops ~$17) — connections are the widest exposure and the loosest COGS correlation.
3. **Trim included knowledge 10 GB → 5 GB.**
With levers 1–3: typical at-cap ≈ $24 — under target. The saving grace either way: simultaneous all-cap usage is rare, and overage opt-in converts the heavy case into revenue.

---

## 3. Fully-loaded worst-case Free org

**≈ $14/mo in the first month (knowledge ingestion month), ≈ $9/mo at all caps steady-state** — see table above. With a Free-tier ingestion cap, worst case ≈ $9–10/mo. At 10,000 all-cap Free orgs that's ~$90–100k/mo exposure ceiling — but the realistic expected cost per Free org is <$1 (most orgs never touch sandbox/knowledge/connections); the abuse-exposure sizing in spec §10 should model the distribution, not the cap.

---

## 4. Verdict summary

| Meter | Placeholder | Verdict | New number |
|---|---|---|---|
| Managed AI | passthrough +15% | **KEEP** | — (confirm intro-vs-sticker base for vendo-* rows) |
| Sandbox minutes | $0.01/min | **KEEP** | — (multiplier for >2 vCPU shapes) |
| Storage | $0.25/GB-mo | **CHANGE** | Keep $0.25 **iff** files→R2/rows→Neon split ships; else $0.45 |
| Knowledge | $0.35/GB-mo | **CHANGE** | **$0.60/GB-mo** (or $0.50 with tuned vector stack committed) |
| Automation runs | $3/1k | **KEEP** | — (enforce mapping rule: AI/broker/sandbox costs ride their own meters) |
| Connections | ~$0.30/conn-mo | **KEEP (contingent)** | — (fair-use enforcement required; re-verify Composio after 2026-08-15) |

Allowance changes recommended: Free knowledge-ingestion cap; Pro included connections 300 → 150; Pro included knowledge 10 GB → 5 GB (optional, only if the $25 target is firm).

---

## 5. Data gaps

**Settled by vendor pricing alone (no usage data needed):** AI margin structure; sandbox rate margin; Neon/R2/Composio unit costs; runs rate margin; the storage verdict (Neon-only $0.25 is underwater regardless of usage).

**Needs real usage data before the pricing page ships:**
1. **Calls per active connection per month** (distribution, not mean) — the most margin-sensitive unknown; sets the fair-use threshold.
2. **Storage GB mix, file bytes vs Postgres rows** — confirms the blended margin under the R2 split.
3. **Vector-to-source size ratio + embedding cost** — depends on the knowledge-stack decision (RAGFlow spec pending); locks the knowledge rate between $0.50 and $0.60.
4. **Sandbox minutes per app build + idle wall-clock share** — allowance sizing and idle-timeout policy.
5. **Automation run compute profile** — allowance sizing.
6. **Free-org usage distribution** — expected (not worst-case) COGS per Free org, for abuse-exposure sizing (spec §10).

**External re-verification dates:** Composio repricing 2026-08-15; Anthropic Sonnet 5 intro pricing ends 2026-08-31.
