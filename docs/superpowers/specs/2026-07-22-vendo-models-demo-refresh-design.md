# Vendo models + demo refresh — design

2026-07-22. Approved in conversation with Yousef. Covers two coupled efforts:
the vendo model family (runtime + gateway), and the Maple/Cadence demo refresh
(Cloud-everything re-integration, permanent hosting, nightly updates, sales
scenarios).

## Goals

- Vendo ships named, hosted models — `vendo`, `vendo-paint`, `vendo-judge`,
  `vendo-extract` — served by the Vendo Cloud gateway. Hosts on Cloud never
  configure model names; hosts who bring provider keys use provider names and
  never encounter vendo-* names at all.
- Maple (demo-bank) and Cadence (demo-accounting) run on Vendo Cloud with
  `VENDO_API_KEY` as the only model/store/tools credential, deployed
  permanently at demos.vendo.run/maple and demos.vendo.run/cadence, rebuilt
  from `main` every night.
- Each demo carries pre-built scenario prompts as visible suggestion chips on
  the assistant landing screen, for sales calls and self-serve visits.

## Part 1 — the vendo model family

### The models

Four hosted models, named for their job:

| Name | Job | Profile |
|---|---|---|
| `vendo` | the agent: chat, tools, full app generation | flagship |
| `vendo-paint` | tier-0 instant first-frame during app generation | fastest streaming, no reasoning |
| `vendo-judge` | guard rulings (run / ask / block) on tool calls | cheap, low latency, called constantly |
| `vendo-extract` | init/sync-time extraction (theme, API, design rules) | quality over latency, offline |

On the Cloud rung these names are literal model ids on the console's
Anthropic-compatible gateway. The console maps each name to a concrete model
server-side — alias mapping is temporary until they are genuinely distinct
hosted models. Clients never see or perform the mapping, so Vendo can retune
every Cloud-keyed app's models without shipping client code.

### Resolution rules

- Model strings always pass through verbatim to whatever the resolved
  credential talks to. Cloud key → the gateway. Provider key → that provider,
  untouched. There is no client-side name translation of any kind. An unknown
  name produces the provider's own error.
- Slot defaults are per rung: Cloud key → the vendo family; provider key →
  that provider's sensible flagship/fast picks (today's behavior). This is the
  entirety of the "magic": defaults, never rewriting.
- Credential ladder is unchanged: explicit provider env key first, then
  `VENDO_API_KEY`, then an honest keyless failure with exact instructions.
- BYO documentation and init output never mention vendo-* names.

### DX surfaces (exactly five)

1. Zero config — `createVendo({ auth, catalog, policy })` with no model
   anywhere; slots resolve to per-rung defaults.
2. One key — `vendo login` (dev) or `VENDO_API_KEY` (deploy), or a BYO
   provider key. Code unchanged.
3. `models` block on `createVendo`, keyed by slot (`agent`, `paint`, `judge`),
   valued by model-name string or an explicit AI-SDK model object. Swapping a
   model is editing a string. Supersedes the top-level `model` key and the
   `paint.model` knob (both remain as deprecated aliases for one release;
   `paint.disabled` survives as the single-lane switch). `extract` has no
   `createVendo` slot — extraction runs in the CLI at init/sync time; when its
   engine ladder runs on an API model it uses `vendo-extract` on the Cloud
   rung and is pinned via `VENDO_MODEL_EXTRACT`.
4. `vendoModel(name?)` — exported, lazily-resolving AI-SDK model bound to the
   app's credential, usable in host code (judge wiring, host features). No
   argument means `vendo`. `devModel` becomes a deprecated alias.
5. Env pins — `VENDO_MODEL` and `VENDO_MODEL_<SLOT>` override per slot with no
   code change. Replaces the per-provider `VENDO_DEV_*_MODEL` vars.

Precedence: explicit model object → env pin → `models` string → per-rung
default.

Deliberately excluded: no judge-on-by-default (a Cloud key must not silently
add an LLM judge to hosts that didn't wire one — too much blast radius); no
doctor role table (aliases resolve server-side, the client would be guessing —
doctor prints the winning credential rung and any active env pins, nothing
more); no documented "point a stock Anthropic client at the gateway" surface.

### Paint becomes invisible

The `paint` knob is demoted from a documented feature to a compatibility
alias. Paint quality/speed is part of what the model family provides: Cloud
rung paints on `vendo-paint`, provider rungs paint on that provider's fast
default. Init and quickstarts never mention paint.

### Cross-repo dependency

The console/web repo must accept the four vendo-* model ids on the gateway
before the demos deploy. Client work does not block on it for BYO rungs but
the demo deployment does.

## Part 2 — demo re-integration (Cloud-everything)

Strip from both `apps/*/src/vendo/server.ts`: explicit `anthropic()` main and
paint models, `createStore(...)`, and Composio connectors. The config keeps
only host-owned concerns: auth preset (`authJs` for Maple, Supabase preset for
Cadence), catalog, policy, MCP config (Maple), apps experiment flags. Every
adapter slot stays unset so `VENDO_API_KEY` composes Cloud defaults: gateway
models, hosted store, managed sandbox, Cloud tools broker, connections.

- Cadence's auto-judge turns on unconditionally via `vendoAutoJudge` on
  `vendoModel("vendo-judge")` — the guard/consent story demos well. Maple gets
  the same treatment for parity.
- The bespoke surface is kept and re-attached: component registries, themes,
  VendoRoot/VendoLayer, workspace/apps pages, voice mode.
- Voice stays OpenAI Realtime with `OPENAI_API_KEY` on the service (Cloud has
  no voice offering; it demos too well to drop).
- Both apps get the `serverExternalPackages` fix for PGlite in production
  bundles (known latent bug, already fixed in the prospect-demo template).
- `demoRequestAllowed` learns the deployed hostnames so voice and demo-reset
  work in production.

## Part 3 — hosting and nightly refresh

Reuse the prospect-demo pipeline: `bench demo:deploy` ships each app as a
Railway service in the `vendo-demos` project and registers it with the
demos.vendo.run router (Cloudflare Worker → Railway router). Maple and Cadence
land at demos.vendo.run/maple and demos.vendo.run/cadence.

- The deploy tooling (`demo:deploy`, `demo:reap`, `tools/demo-router`) lives
  on the unmerged demo-creator branch (PR #316); it must merge or be extracted
  to `main` first — nightly CI depends on it.
- `demo:deploy` learns to set `VENDO_API_KEY` (plus `OPENAI_API_KEY` for
  voice) on these services instead of `ANTHROPIC_API_KEY`.
- Maple and Cadence are marked permanent: exempt from `demo:reap` and the
  14-day expiry.
- With `VENDO_API_KEY` set the store composes to Cloud hosted persistence, so
  grants, saved apps, and automations survive nightly redeploys — deliberate:
  accumulated state makes the demos feel lived-in. No automatic reset; the
  existing `/api/demo/reset` route stays available as a manual reset if a
  call ever needs a clean slate.
- Nightly refresh is a GitHub Actions cron: checkout `main` → build →
  `demo:deploy` both apps (workspace deps pick up the latest Vendo
  automatically) → smoke test each live URL (login plus one real agent turn) →
  alert Yousef on failure. Nothing ships silently broken into a call day.
- Stretch, not required: the nightly job re-runs `vendo init` against each
  demo first, as standing dogfood of the install funnel.

## Part 4 — demo surfaces (anti-bolted-on)

Findings from the 2026-07-22 live walkthrough of Maple: the launcher is
suppressed (`launcher="none"`), so Vendo has zero visible presence — entry is
an unlabeled ⌘K or a sidebar link to a separate page; the one native surface
(the Home slot with a pinned app) is not marked as interactive. Decisions:

- Launcher ON, branded per host ("Ask Maple" / Cadence equivalent, host mark
  as icon), in both demos. ⌘K stays as the power path. The full-page
  assistant routes stay but stop being the front door.
- Contextual triggers: `VendoTrigger` affordances on records — Maple
  transaction rows/detail and Insights, Cadence invoices/clients — opening
  the overlay with a prefilled (never auto-sent) prompt plus the record as
  context.
- Slots: keep Maple's Home slot; add labeled EMPTY slots (ghost state with
  suggestion chips) on Maple Insights and on Cadence's dashboard, so the
  save-as-app beat lands inside real product pages.
- Overlay presentation stays the centered modal — explicitly no side-panel
  work (decision).

## Part 5 — generation quality (the v4 stack)

The demos currently run the OLD create contract: v4 PR1 (#462) merged behind
the `promptRewrite` pipeline flag, `createVendo` does not thread a pipeline
config at all, and the rest of the v4 wave is unmerged (#490 data-sighted
verification, #496 invented-data validator, #498 smoke-render gate, #499
Cadence design-rules rewrite). Work:

- Land the open v4 PRs (review, fix, merge).
- Thread `apps.pipeline` through `createVendo` so hosts can opt in.
- Demos enable the full v4 set (promptRewrite + structuredRepair +
  regionParallel + endPass); live demo experience feeds the decision on
  flipping `promptRewrite` to default (pairwise: 17W/13L/10T — favored, not
  conclusive).
- Agent response discipline (runtime prompt): never restate an embedded
  app's data as markdown tables; no emoji unless the host's voice uses them;
  no filler narration about the UI ("the chart is loading above"). Observed
  verbatim in the walkthrough.

## Part 6 — sales scenarios

Each demo ships pre-built prompts as visible suggestion chips on the
assistant landing screen (decision: chips, not a hidden palette). The chips
form a capability ladder that demonstrates the FULL agentic experience —
generated UI, host-API tool calls, guard approvals, external integrations,
automations, save-as-app:

- Maple: "Where did my money go?" (generated UI) → "Move $200 to savings"
  (host tool call, guard approval card approved live) → "Email me this
  summary every Friday" (Gmail via the Cloud tools broker + an automation,
  judge-guarded sends) → pin the dashboard into the Home slot.
- Cadence: "Which invoices are overdue?" (generated UI) → "Draft reminder
  emails to those clients, ask me before each send" (Gmail + per-send
  approvals) → "Put invoice review on my calendar monthly" (calendar +
  automations) → pin the aging report to the dashboard slot.

The Activity panel closes each demo: the ledger of what the agent did and
who approved what is the trust story.

Known constraint: `VendoThread`'s suggestions prop is landing-only and
unlabeled today; if labeled chips are wanted, that is the existing
`packages/ui` labeled-suggestions follow-up ({label, prompt}).

## Build order

1. Runtime model-family lane (OSS): passthrough + per-rung defaults,
   `vendoModel`, `models` block, env pins, deprecations, doctor lines.
   (Running in a parallel session as of 2026-07-22.)
2. Console gateway: accept the four vendo-* ids (web repo).
3. Generation-quality lane: land open v4 PRs (#490 #496 #498 #499), thread
   `apps.pipeline` through `createVendo`, agent response discipline.
4. Demo re-integration + surfaces PR(s): both apps — Cloud-everything, judge
   on, PGlite fix, hostname allowance, branded launcher, triggers, empty
   slots, scenario chips, v4 pipeline flags on.
5. Deploy tooling to `main` (merge or extract from PR #316), `demo:deploy`
   VENDO_API_KEY support, permanence flags.
6. First manual deploy of both demos; verify live in a real browser.
7. Nightly workflow + smoke test + alerting.

## Out of scope

- Judge as a Cloud-defaulted slot.
- Client-side vendo-* name mapping for BYO rungs.
- A hidden scenario palette (chips only, per decision).
- New voice infrastructure.
- `demo.vendo.run` (singular) — the live infra is demos.vendo.run and these
  demos join it.
