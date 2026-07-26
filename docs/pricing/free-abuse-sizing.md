# Free-Tier Abuse Exposure Sizing

**Date:** 2026-07-24 · **Feeds:** `docs/superpowers/specs/2026-07-24-usage-and-pricing-design.md` §10 open item ("sizing of free-quota abuse exposure").
**Free tier under analysis (§2):** $5/mo AI credit, 200 sandbox min, 1 GB storage, 1 GB knowledge, 100 automation runs, 20 active connections — all hard caps (§5), no card ever.

---

## 1. Worst-case COGS of one maxed-out Free org

Vendor price anchors (verified 2026-07-24):

| Input | Vendor price | Source |
|---|---|---|
| Sonnet-class inference | Claude Sonnet 5: $3/MTok in, $15/MTok out (intro $2/$10 through 2026-08-31) | [Anthropic pricing](https://platform.claude.com/docs/en/pricing) |
| Sandbox compute | E2B: $0.0504/vCPU-hr + $0.0162/GiB-hr RAM, wall-clock billed per second (idle = billed) | [E2B pricing estimator](https://pricing.e2b.dev/), [Morph E2B breakdown](https://www.morphllm.com/e2b-pricing), [Northflank comparison](https://northflank.com/blog/ai-sandbox-pricing) |
| Postgres storage | Neon: $0.35/GB-month flat (down from $1.75 post-Databricks acquisition) | [Neon pricing 2026](https://vela.simplyblock.io/articles/neon-serverless-postgres-pricing-2026/), [Prisma vs Neon](https://www.prisma.io/blog/prisma-postgres-vs-neon-pricing-2026) |
| Tool calls (broker) | Composio: 20K calls free; $29/mo → 200K calls, overage $0.299/1k (our blended COGS ≈ $0.11/1k per spec §3.6); premium tools ≈ 3× | [Composio docs](https://docs.composio.dev/toolkits/premium-tools), [freetier.co](https://freetier.co/directory/products/composio) |
| Doc parse/OCR | LlamaParse: 1 credit/page no-AI ($0.00125), 3 credits cost-effective ($0.00375), up to 90 credits/page agentic ($0.1125) | [LlamaParse pricing](https://www.llamaindex.ai/pricing), [docs](https://developers.llamaindex.ai/llamaparse/general/pricing/) |

Per-meter worst case, one org, one month:

| Meter | Cap | Worst-case COGS | Math |
|---|---|---:|---|
| AI credit | $5, hard stop | **$4.35** | Dollar-denominated at passthrough+15% → provider spend ceiling = $5/1.15, independent of model mix. Intro Sonnet 5 pricing only stretches how many turns fit, not the $ ceiling. |
| Sandbox | 200 min | **$0.55** | 2 vCPU/4 GiB E2B-class: (2×$0.0504 + 4×$0.0162)/60 = $0.00276/min × 200. Wall-clock cap makes this a true ceiling. |
| Storage | 1 GB | **$0.35** | 1 GB-mo × Neon $0.35. |
| Knowledge (storage) | 1 GB | **~$0.50** | docs + vectors ≈ 1.3–1.5 GB physical × $0.35. |
| Knowledge (ingestion, per fill) | — | **$5–19 text/scans; $560 pathological** | Text: 1 GB ≈ 250M tokens embedded @ ~$0.02/MTok ≈ $5. Scanned docs: ~5,000 pages/GB @ $0.00125–0.00375/page parse ≈ $6–19 + embed. Agentic parse mode would be $0.1125/page ≈ **$560/GB** — must never be routed on Free. |
| Automation runs | 100/mo | **~$0** | Orchestration is pennies; run inference draws the AI credit (self-capping); tool calls priced below. |
| Connections + tool calls | 20 conn | **~$0.30** | Dormant connections ≈ $0 (COGS is per call). 100 runs × ~10–30 calls ≈ 1–3k calls × $0.11/1k. |
| Threads/memory/logs | 7-day retention | **~$0** | Text; single-digit MB. |

**Totals:**
- **Steady state: ≈ $6/org/mo** ($4.35 AI + $0.55 sandbox + $0.85 storage+knowledge + $0.30 calls).
- **First month with one 1 GB knowledge fill: ≈ $11–25.**
- **Unbounded term: ingestion churn.** Storage is metered as GB-*stored*, ingestion is one-time — delete-and-re-upload cycles re-pay parse+embed every cycle while never exceeding the 1 GB cap. 30 cycles/mo of scanned docs ≈ **$200–600/org/mo**. This is the only per-org line without a natural ceiling → needs its own guardrail (§4).

## 2–3. Abuse vectors: ceiling and standard countermeasure

Countermeasure precedents (verified): Chatbase **deletes free agents after 14 idle days** ([pricing](https://www.chatbase.co/pricing), [reviews](https://www.featurebase.app/blog/chatbase-pricing)). Supabase **pauses free projects after 7 days of no API activity**, 90-day restore window, then removal ([docs](https://supabase.com/docs/guides/platform/free-project-pausing)). Fly.io **requires a card for all orgs** explicitly "to check you are a human and avoid abuse," and killed its free tier in 2024 ([community](https://community.fly.io/t/does-the-free-tier-require-a-credit-card-or-credits-to-be-added-to-the-account/5803), [pricing](https://fly.io/docs/about/pricing/)). Railway killed its free tier in 2023 after cryptominers, and now **gates its trial on GitHub account age/activity** — verified GitHub → full trial; unverified → restricted egress and ports ([trial docs](https://docs.railway.com/pricing/free-trial), [station thread](https://station.railway.com/questions/limited-trial-to-prevent-abuse-of-free-17a2c7ca)). Vercel Hobby: non-commercial only, pauses on limit, **terminate-at-discretion** ToS ([Hobby docs](https://vercel.com/docs/plans/hobby), [ToS](https://vercel.com/legal/terms)). "Freejacking" of free CI/trial compute is an industrialized practice (Purpleurchin: 30 GitHub / 2,000 Heroku / 900 Buddy accounts — [Sysdig](https://www.sysdig.com/blog/massive-cryptomining-operation-github-actions)).

| # | Vector | Realistic cost ceiling | Standard countermeasure |
|---|---|---|---|
| 1 | **Multi-account farming** (N orgs × free caps; the meta-vector — multiplies all others) | ~$6/org/mo steady; 1,000 farmed orgs ≈ **$6k/mo**, dominated by the $4.35 inference credit. Resale of gateway access is the economic motive. | One free org per verified user; sign-in identity stronger than email (GitHub w/ account-age heuristic — Railway); IP/device-fingerprint clustering + org-creation velocity limits; card (Fly) — **off the table for Vendo** (no-card is locked). |
| 2 | **OCR-farm via knowledge ingestion** (they "pay" $0 storage, we pay parse/OCR) | $5–19 per 1 GB fill; **$200–600/mo per org** via delete/re-upload churn — worst per-org vector. | Per-file cap + **monthly ingestion cap decoupled from stored GB** + cheap-parse-only tier on Free; pathological cases to fair-use terms (spec §3.4 already points here). |
| 3 | **Storage parking** (free 1 GB backup/dumping ground forever) | $0.85/org/mo (storage+knowledge). 10k parked orgs ≈ $8.5k/mo — a slow bleed, not a spike. | Idle decay: Supabase pause-at-7-idle-days / Chatbase delete-at-14 pattern. Kills parking outright since parked orgs are idle by definition. |
| 4 | **Sandbox crypto-mining / compute abuse** | 200 min × 2 vCPU ≈ **$0.55/org and ~$0.001 of coin** — mining is uneconomic at this cap; real risks are proxy/egress abuse and farming (vector 1). | Concurrency cap 1, hard wall-clock session limit, no GPU, wall-clock=metered (idle burns their own cap), default-limited egress for unverified orgs (Railway's restricted-trial model). |
| 5 | **Connection farming** (20 free conn as a free Composio proxy) | Dormant conns ≈ $0 (COGS per call). Abuse = call volume through automations: 100 runs × 1,000 calls = 100k calls ≈ **$11/org/mo**. | Per-run tool-call cap; the §3.6 fair-use clause on calls↔connections; premium-tool actions excluded from Free. |
| 6 | **Automation-run spam** | Hard-capped at 100 runs; run inference draws the $5 credit → self-capping. Ceiling ≈ **$1–11** incl. tool calls. | Cap already exists; add min schedule interval + runs auto-pause when org goes idle (feeds vector-3 decay). |
| 7 | **Credit-stuffing via disposable emails** (vector 1 optimized for the $5 credit alone) | $4.35 × N; a 100-account/day script ≈ **$13k/mo** if unchecked. Email verification alone is defeated by disposable domains in minutes. | Disposable-domain blocklist + email verification as floor; **full caps only behind OAuth identity with age signal** (Railway); reduced caps for email-only signups; gateway RPM limits on Free so a credit can't be drained in minutes. |

**Aggregate blast radius:** honest maxed-out Free orgs are fine — $6/mo COGS against a funnel that converts. The exposure is (a) ingestion churn per org and (b) account multiplication. Both are guardrail problems, not pricing problems; the caps in §2 of the spec are correctly sized.

## 4. Recommended Vendo guardrail set

1. **Per-file upload cap (knowledge + storage): 10 MB/file on Free** (Pro 100 MB), max 500 files in knowledge. Blocks single-blob dumps and keeps parse jobs small.
2. **Monthly knowledge-ingestion allowance, decoupled from stored GB: 2 GB ingested/mo on Free**, hard stop (same §5 error shape: reset date + upgrade/BYO exits). Kills the churn loophole — stored-GB caps alone don't. Free always routes to the cheap parse tier (~$0.001–0.004/page), never agentic parse; worst case falls from ~$600 to ~$40/org/mo, and to ~$12 with the 2 GB cap.
3. **Idle-org decay: 21 idle days → services paused** (idle = no gateway/sandbox/store/broker/scheduler call and no console login; warning email at day 14, Chatbase-style), **paused 90 days → data deleted** (Supabase-style restore window; 3 warning emails). Automations stop firing at pause — loudly, per §5 degrade asymmetry.
4. **One Free org owned per user** (membership in others unlimited); org-creation velocity limit ~3/day per IP/device fingerprint; disposable-email-domain blocklist at signup.
5. **Sandbox: concurrency 1, max 20 min wall-clock per session, 2 vCPU/4 GiB fixed, no GPU**; default-limited egress (package registries + broker + host API) until the org is identity-verified.
6. **Email verification is the floor, not the gate: full Free caps require GitHub (or Google Workspace) sign-in, with a Railway-style age/activity heuristic on GitHub accounts (< ~30 days old → reduced caps).** Email-only orgs get a reduced lane ($1 AI credit, 50 sandbox min, no automations) until they add OAuth identity. No card ever — that constraint is locked; identity strength substitutes for it. Plus Free-tier gateway rate limits (e.g. ≤ 10 req/min) so a $5 credit cannot be drained programmatically in minutes.

**Residual exposure with this set:** ≈ $6/org/mo honest ceiling, ingestion capped ≈ $12, farming requires aged GitHub accounts at ~3 orgs/day/device — cost of attack exceeds the $4.35/mo yield. Acceptable.
