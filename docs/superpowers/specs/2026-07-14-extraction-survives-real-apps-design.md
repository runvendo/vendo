# Extraction that survives real apps: design

Date: 2026-07-14
Status: approved by Yousef (brainstorm session, section-by-section)
Linear: https://linear.app/runvendo/project/extraction-that-survives-real-apps-832107808403
Benchmark context: Okibi (YC S25) Bookface launch thread. Surge: "functions that right now are only exposed to our frontend"; Amplitude: "the APIs we had for the UI used a lot of client side logic to make the app work." One-shot generation is not enough; the answer is gap detection plus iterative agent-assisted refinement.

## Outcome

"Any API shape, zero config" becomes honest: OpenAPI, tRPC, GraphQL, server actions, plain routes produce correct, risk-labeled tools at `vendo init`, and the gap between what the host API exposes and what its UI can do is detected, measured, and closed through a refinement loop.

Finish line (all three):
1. New-shape corpus green: tRPC, GraphQL, and server-actions fixtures pass Layers 1-2 at the existing bar.
2. One gnarly real app end to end: teable (deep tier) passes a live task suite whose tasks require client-side orchestration, with refine-produced compound tools in play.
3. Refinement loop shipped as a product feature: miss capture, gap dashboard, `vendo refine`.

## Locked decisions

- Deterministic base, agent layer on top. Static extractors remain the source of truth for primitive tools; the agent only adds, via separate reviewable artifacts. No LLM in the base extraction path.
- Compound capabilities are a new additive `compound` binding kind (Approach A), not automations reuse, not briefs-only.
- Per-step guard. Compound execution routes every step back through the guard-bound registry. No second execution path. Batch-approval UX (one card mints a scoped grant for the plan) is a follow-up; v1 shows per-step approvals.
- Agent-authored output lives in `.vendo/capabilities.json` (`vendo/capabilities@1`), separate from deterministic `tools.json`, merged at load like overrides.
- Server actions execute by direct in-process registration through the generated wiring file. No Next action-id bindings.
- One refine engine, two surfaces: `vendo refine` command plus an end-of-init offer. Local BYO-key v1; inputs and outputs designed so the same engine can run in a cloud sandbox later.
- Miss capture is cloud-first: local `.vendo/data/misses.jsonl` always, cloud upload with `VENDO_API_KEY`, and the full gap dashboard ships in this project (console, vendo-web repo).
- Tool explosion handled by agent-layer curation plus a runtime tool-search loadout mechanism. Both owned fully by this project.
- Contract changes are additive within `vendo/tools@1`, one amendment PR per milestone that needs one, each gated on Yousef sign-off.
- Fixtures: Rallly (tRPC), Twenty (GraphQL), NextCRM (server actions), teable promoted to deep-tier gnarly flagship. No license restrictions.

## 1. Breadth extractors

`vendoSync` (packages/actions/src/sync/index.ts) gains an `Extractor` interface (detect, extract returning tools plus warnings) and a registration list. OpenAPI and route-scan become the first two registrations. New extractors and binding kinds:

- tRPC (`kind: "trpc"`). Static parse of routers using the TypeScript compiler API. Zod input schemas are statically interpreted into JSON Schema for common patterns; unrecognized validators fail closed to a permissive schema with a note. Execution: tRPC HTTP envelope against the host mount (typically `/api/trpc`).
- GraphQL (`kind: "graphql"`). Schema read statically from SDL or code-first sources. One tool per query and mutation; inputSchema derived deterministically from GraphQL argument types; depth-limited default selection sets. Execution: POST query plus variables.
- Server actions (`kind: "server-action"`). Scan `"use server"` modules. The generated wiring file imports the action modules and passes a registration map into `createVendo`; dispatch is in-process.

Risk labeling extends the existing fail-closed rules: tRPC and GraphQL queries get `read` only with a read-shaped name; mutations default to `write`; the destructive word list applies unchanged; unclassifiable surfaces emit `disabled: true` with a note.

## 2. Compound tools

Additive `compound` binding kind in the `ToolBinding` union (packages/actions/src/formats.ts): ordered steps reusing the core `Step` shape (JSONata arg mapping, `if`, `forEach`, defined in docs/contracts/01-core.md section 11), each step referencing a primitive tool by name. The actions layering rule holds: actions imports core only.

Execution: the registry walks steps through an `invokeTool` callback that the umbrella wires to the guard-bound registry, so grants, approvals, and breakers see every real call. Descriptor risk equals the max of step risks, validated at load. The step-walker semantics must match automations' step semantics; single-source where practical.

Compounds and capability briefs live in `.vendo/capabilities.json`, authored by the refine engine, loaded and merged by the registry alongside overrides. Deterministic and agent-authored artifacts stay separate and diffable.

## 3. Refine engine

Home: the umbrella package (packages/vendo), exposed as a programmatic API plus the CLI command. Provider: BYO key through the existing provider-agnostic seam.

Inputs: static extraction output, frontend and backend source, a running dev app (probe and verify through the host's own Vendo endpoint, reusing doctor machinery), the miss feed, and an interactive dev interview.

Outputs, all reviewable git diffs, never silently applied: compounds and briefs into `capabilities.json`; risk corrections and enable/disable curation into `overrides.json`; description improvements; `brief.md` updates.

Loop: propose, probe to verify each proposed capability against the dev app, present the diff, apply on approval.

Contract language: "extraction is a build step, never a command" is amended to scope the build-step rule to sync; refine is explicitly a command.

## 4. Runtime tool search

The agent starts with the curated enabled set and gets a `vendo_tools_search` meta-tool to discover and load additional host tools mid-run. Built in the agent package plus an actions registry query API.

## 5. Miss capture and gap dashboard

A capability-miss event shape is added to the contracts: emitted when the embedded agent cannot fulfill a user ask. OSS always appends to `.vendo/data/misses.jsonl`. With `VENDO_API_KEY`, events upload to cloud insights. The console (vendo-web repo) gains a gap dashboard: misses clustered by intent, diffed against the extracted surface, with an export-to-refine flow that `vendo refine` consumes.

## 6. Corpus and evals

- Onboard Rallly, NextCRM, and Twenty with expectations. `expected.json` tool identity grows binding-kind-aware keys (procedure and operation names, not only method plus path). Twenty adds a Redis service kind to the bootstrap schema; it is deliberately the only heavy boot.
- teable moves to deep tier as the gnarly flagship with hand-written task expectations for client-orchestrated flows: bulk paste into cell ranges, field type conversion with backfill, view reconfiguration, CSV import with field creation, kanban drag. Scored live pass@k.
- New UI-parity audit layer: an agent enumerates what the frontend can do and diffs it against extracted plus refined tools, producing a coverage metric per repo. LLM-costed, nightly only, like Layer 3.

## 7. Contract amendments

Additive within `vendo/tools@1`: new binding kinds (trpc, graphql, server-action, compound); the `vendo/capabilities@1` format; the miss-event shape; updated extraction-tier and build-step-versus-command language in docs/contracts/04-actions.md. One amendment PR per milestone that needs one, each gated on Yousef.

## 8. Milestones and execution

Child orchestrator sessions per workstream; codex sol executes (Opus 4.8 only when sol is blocked). Novel or risky core stays single-stream with tight review.

| # | Milestone | Depends on | Stream |
|---|---|---|---|
| M1 | Extractor seam, tRPC extractor, Rallly fixture | none | child A (proves the seam) |
| M2 | GraphQL extractor, Twenty fixture | M1 seam | child B |
| M3 | Server-actions extractor, NextCRM fixture | M1 seam | child C |
| M4 | Compound binding, guard semantics, contract amendment | none | single-stream |
| M5 | Refine engine | M4 | single-stream |
| M6 | Tool search and loadout | M1 | child D |
| M7 | Miss capture, cloud dashboard (vendo-web) | miss-event shape | child E, cross-repo |
| M8 | teable flagship, UI-parity layer, finish-line run | M1-M6 | orchestrator plus sol |

## Out of scope

- Batch-approval UX for compounds (follow-up after v1 per-step approvals).
- Cloud sandbox execution of refine (seam designed, not built).
- Non-JS hosts (Saleor-style introspection fixtures) and additional gnarly targets (Twenty as flagship, cal.com promotion) beyond the chosen set.
- meter, memory, knowledge blocks (parked post-GA).
