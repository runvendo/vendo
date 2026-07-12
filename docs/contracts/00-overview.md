# Vendo v0 Contracts — Overview

Status: DRAFT — wave 2 of the v0 campaign, awaiting Yousef's review. Nothing ports or builds until this set is approved and frozen.
Sources of truth: the "Open-Source Full Stack Agentic Interface" Notion page and `docs/superpowers/specs/2026-07-11-app-format-design.md`. Every contract here is derived fresh from those two documents; old code proves nothing, except where the app-format spec explicitly pins compatibility (the `vendo-genui/v1` wire format and the grant machinery).

## The v0 cut

| Package | One job | Contract |
| --- | --- | --- |
| `@vendoai/core` | the shapes everything speaks | [01-core.md](01-core.md) |
| `@vendoai/store` | persistence under everything (Postgres-only) | [02-store.md](02-store.md) |
| `@vendoai/agent` | run the conversation | [03-agent.md](03-agent.md) |
| `@vendoai/actions` | every API becomes agent tools, executed as the signed-in user | [04-actions.md](04-actions.md) |
| `@vendoai/guard` | policy, approvals, audit, safety | [05-guard.md](05-guard.md) |
| `@vendoai/apps` | the app artifact + the engine that builds and runs them | [06-apps.md](06-apps.md) |
| `@vendoai/automations` | apps that run on triggers while the user is away | [07-automations.md](07-automations.md) |
| `@vendoai/ui` | headless hooks + optional chrome, every surface | [08-ui.md](08-ui.md) |
| `@vendoai/vendo` | the umbrella: default composition, wire routes, CLI | [09-vendo.md](09-vendo.md) |

Deferred entirely — no stub packages, no reserved exports: `meter`, `memory`, `knowledge`, `mcp` (door), `evals`. `@vendoai/telemetry` stays as-is (orthogonal to the campaign).

## The dependency rule

Layered, enforced by the dependency-guard CI gate:

```
core → apps → automations        (the one chain: apps builds on core, automations builds on apps)
store, agent, actions, guard, ui → depend on core only
vendo (umbrella) → depends on everything (the only package allowed to)
```

(Arrows on the first line read "builds on", left to right — i.e. automations imports apps imports core; nothing imports in the other direction.)

Cross-block communication happens exclusively through seams defined in core (`Guard`, `StoreAdapter`, `ActAs`, `SecretsProvider`, `AgentRunner`, `ToolSet`). A block never imports a sibling; the umbrella wires implementations into seams. Two consequences worth naming:

- `automations` never imports `agent`. Agentic runs go through the `AgentRunner` seam (core); the umbrella passes the agent's implementation in.
- `ui` never imports `apps`. The browser talks to the server over the umbrella's wire routes (09); types come from core.

## Conventions (all packages)

- **Types + zod, end to end.** Every wire-crossing or persisted shape ships a TS type and a zod schema named `<camelCaseName>Schema` (e.g. `AppDocument` / `appDocumentSchema`). Tool *inputs* are JSON Schema (interop with LLM APIs and MCP), produced from zod where authored in TS.
- **Ids** are plain strings with stable prefixes: `app_`, `grt_` (grant), `apr_` (approval), `run_`, `thr_` (thread), `aud_` (audit).
- **Timestamps** are ISO-8601 strings, UTC.
- **Errors**: one `VendoError` taxonomy in core; fail-soft states (`pending-approval`) are *outcomes*, not exceptions.
- **Runs anywhere**: core, agent, actions, guard, automations, apps make no platform assumptions beyond fetch + WebCrypto (Node ≥ 20, edge, Bun). store is the only block allowed a driver dependency (pg / PGlite). ui is the only block with a React peer; `ai` is a **peerDependency** wherever the `LanguageModel` seam appears (agent, guard, apps) — the host owns the one install, same singleton rule as React.
- **One version train**: all `@vendoai/*` release together; core is semver-sacred — its shapes freeze at this review and breaking changes require a major.
- **Identity optional**: no host principal resolver → an ephemeral session-scoped principal; everything works, nothing persists past the session.
- **Cloud line**: contracts define the *shapes* for cloud-gated features (sharing, publishing, org overlay, pinning) because OSS types are the interface cloud implements against. OSS implementations of those surfaces throw `VendoError('cloud-required')` unless `VENDO_API_KEY` lights them up. Everything else is complete in OSS.

## Decisions made in this wave

Resolved with Yousef (2026-07-11 dialogs):

1. **Server execution protocol = plain HTTP paths.** The machine is just a web server on `$PORT`: `POST /fn/<name>`, everything else is the rung-4 app. Context via env + headers. (06 §4; the originally-reserved separate `/trigger` path was trimmed in decision 19 — firings arrive as `fn:` steps.)
2. **Tree → server function references = `fn:` URI scheme.** `fn:<name>` is valid anywhere a tree binds a data source or an action; no new top-level tree field. (01 §8, 06 §4)
3. **BYO-LLM seam = the ai-SDK `LanguageModel`.** The agent (and every LLM-consuming seat: judge, generation engine) accepts a Vercel AI SDK model; every provider ships one. (03)
4. **Deterministic pipelines = minimal steps + JSONata.** Ordered tool-call steps with JSONata for arg mapping, `if`, `forEach`. (07 §4)

Made while drafting — flagged for review, each also marked ⚑ in situ:

5. **All shapes live in core, including the app document and the tree** (the page puts "tools, principals, apps, grants" under core's typed-end-to-end bullet; the apps *block* owns engine/runtime/spec doc). Required by layering: ui renders trees but may only import core.
6. **The guard choke point is `guard.bind(tools)`** — the only sanctioned path from a `ToolSet` to execution, used identically by chat, apps, automations, and the future MCP door. (05 §2)
7. **`SandboxAdapter` lives in apps** (its only consumer), with e2b and Modal adapters in-box as subpaths (`@vendoai/apps/e2b`, `/modal`) — BYO key, per the page.
8. **Secrets are handles, substituted at the egress boundary** — app code never sees values (page: "never readable by app code"); the machine's egress proxy swaps handle tokens for real values on allowlisted domains. (06 §4.3)
9. **The umbrella owns the `vendo` bin** (init/doctor/sync); no separate published CLI package.
10. **ui is one package** absorbing the old react/client/shell/components/stage, with subpath exports.
11. **Store's table map is public contract** (the page makes tables host-queryable): names + key columns stable, other columns documented but evolvable within the version train.
12. **`docs/contracts/seams.md` is superseded** by this set; it describes the pre-v0 world and should be deleted when wave 3 lands.

Resolved with Yousef, round 2 (2026-07-11, during review):

13. **The instant-path UI payload is format-tagged, not tree-forever.** The two planes stay contract (`ui: "tree" | "http"` = instant/jailed vs machine-served); the payload dispatches on `formatVersion`, and v0 registers exactly one format — the tree, `vendo-genui/v1`, unchanged and stored-record compatible. Future formats (compact profile, v2, non-tree) slot in behind the tag. (01 §8)

14. **No installs — every user has an app.** The install object is deleted; the user-owned app row is the one concept. Data and grants key off the owner's `AppId`; sharing/publishing/import hand over a copy with a **freshly minted id** (ids inside artifacts are never trusted), so artifacts still carry zero authority — the same security property as the spec's "install records", one concept fewer. (01 §10)

Round 3 (dual review — a simplification pass and an industry-standards pass, both applied 2026-07-11):

15. **Tool names are provider-safe**: `/^[a-zA-Z0-9_-]{1,64}$/` with `_` as the namespace separator (`host_invoices_list`). Dot-paths are rejected outright by both OpenAI and Anthropic tool-name validation; a rename shim would break `descriptorHash`-bound grants. (01 §4)
16. **Webhook signing meets the Stripe/Svix bar**: HMAC-SHA256 over `id.timestamp.rawBody`, ±5-minute window, delivery-id dedupe; secrets never travel in URLs. (09 §3)
17. **No tenant axis** ⚠️ new: `tenantId` deleted from principals, grants, and every table — `subject` is the one partition key; multi-tenant hosts scope by joining through it, like their own tables. Re-adding a column later is additive; carrying it "just in case" was not. (02 §4)
18. **Standards one-liners**: `descriptorHash` = SHA-256 over RFC 8785 canonical JSON; one wire error envelope + fixed status map; `/fn` responses use an explicit `{ result }` / `{ ui }` key, never body-sniffing; `/tick` takes `Authorization: Bearer` (Vercel cron native); cron evaluates in UTC; wire POSTs require `Content-Type: application/json` (CSRF floor); the refs join example uses GIN-compatible containment.
19. **Simplification trims** (dead surface deleted): `apply()` + the `TreePatch`/`CodePatch` public types (edit dialects are engine internals; `edit()` is the one entry), the machine's `/trigger` endpoint (firings arrive as declared `fn:` steps), `audit.activity` (= `query({principal})` at the wire route), the separate `directions` config channel (policy data, one channel), `BreakingChange.affects` (contractually always empty), grant sources `judge`/`rule` (nothing mints them), `ToolDescriptor.title`, the umbrella's judge shorthand union, store's `maintenance()`/`auditRetentionDays` (host SQL on host tables), and app-data encryption (kept for `vendo_secrets` only — encrypting app data defeats the host-queryable promise).

## Wave 3+ ground rules (fresh-start mechanics, same repo)

Approved with the contracts (Yousef, 2026-07-11): the blocks are built as if from a fresh codebase, inside this repo.

1. **Every block is a brand-new package directory**, scaffolded empty from its contract doc. Nothing starts as a copy of an old package.
2. **The dependency-guard CI gate forbids new packages from importing old ones.** Old packages are a read-only quarry: code transplants into a new block only when it satisfies the frozen contract, and arrives in the diff as an addition.
3. **Old packages are deleted in the same wave their replacement goes green.** The quarry shrinks to zero by wave 7; old and new never ship together.

## Reading order

01-core defines every shared shape; each block contract then only adds its own API. Read 01 first; 06 (apps) contains the server execution contract and is the largest.
