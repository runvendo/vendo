# demo-fidelity — verification

Three changes so a generated prospect demo behaves like the real product, and
so building one can never leak a prospect's name into the OSS repo.

| Criterion | Verdict | Evidence |
|---|---|---|
| T1[1] default create target resolves outside the repo root | PASS | `bench/src/demo-creator/create.test.ts` "defaults the CTA and targets a scratch dir OUTSIDE the repo"; `scratch.test.ts` "defaultDemoScratchDir" |
| T1[1] `apps/demo-*` gitignored except the three real apps | PASS | `gitignore-check.log`; `scratch.test.ts` › "apps/demo-* gitignore" (runs real `git check-ignore`) |
| T1[2] a clone in the scratch location runs `pnpm build` green | PASS | `scratch-clone-build.log` — real clone at `<os-tmp>/vendo-demos/demo-fidelity-proof-d`, `pnpm install` + `pnpm build` from that directory, 8 routes emitted |
| T1 (narrative) the clone deploys from the scratch location | PARTIAL — plan proven, not executed | `deploy-dryrun-standalone.log`, `standalone-Dockerfile.txt`. No live Railway run: the contract forbids me deploying (the conductor deploys). |
| T2[1] `VENDO_API_KEY` + no explicit slots ⇒ hosted store + Cloud connections | PASS (composition) | `apps/demo-template/src/vendo/server-config.test.ts` "deployed: leaves store + connections UNSET…". Not exercised against live Cloud: no `VENDO_API_KEY` exists yet (conductor provisions it). |
| T2[1] the local pin composes the local store | PASS | same file, "local dev: DEMO_STORE=local pins the local PGlite store" |
| T2[1] caps guard + spend middleware remain wired | PASS | same file, "keeps the caps guard + spend middleware wrapped around the model" |
| T3[1] N tools ⇒ 4-5 chips referencing real capabilities | PASS | `chips-live-demo.config.json` — a LIVE derivation over Maple's real 24-tool surface |
| T3[1] explicit beats override derived | PASS | `bench/src/demo-creator/chips.test.ts` › `mergeBeats` + `runDeriveChips` "derives pills… kept 3, derived 2" |
| T3[1] empty/missing tools.json ⇒ no chips, no crash | PASS | `chips.test.ts` "is a no-op with no tool surface: no chips, no crash, no model call" |

## T1 — the leak fix, and the caveat it forced

`demo:create`'s default target is now `<os-tmp>/vendo-demos/demo-<id>`, and
`apps/demo-*` is gitignored bar `demo-bank` / `demo-accounting` /
`demo-template`.

The caveat the contract named — the template's `workspace:*` deps — was
resolved by **vendoring**, not by the two options the contract listed, on
evidence found while doing it:

> Published `@vendoai/vendo@0.4.8` does not export `vendoModel`; the workspace
> package at the *same version string* does. main runs ahead of the registry
> between releases, so pinning "the exact versions currently in the workspace"
> produces a clone that fails to build today and would demo a release-old
> Vendo even once it did. Symlinking (the other option) builds locally but
> cannot be uploaded to Railway, so it would leave `demo:deploy` broken.

So `demo:create` `pnpm pack`s this tree's fourteen publishable `@vendoai/*`
packages into the clone's `vendor/` (~6MB, ~10s) and repoints the clone's
deps there — plus a clone-local `pnpm-workspace.yaml` that forces the same
tarballs **transitively** through `overrides` (pack rewrites a package's own
workspace deps to registry versions, so without this the stale published
copies reappear underneath) and carries the repo root's security floors,
which the template would otherwise lose (it pins `next: 16.2.9`, below the
root's `>=16.2.11` floor).

Live proof — `scratch-clone-build.log`:

```
Done in 8.1s using pnpm v11.10.0
=== BUILD ===
$ vendo sync .   →  tools: +0 -0 ~0
$ next build     →  ✓ Compiled successfully
   ○ /   ƒ /api/items   ƒ /api/vendo/[...vendo]   ƒ /demo-status   ƒ /login   ƒ /vendo
```

`demo:deploy` follows the same split: an in-repo app deploys the monorepo
exactly as before (`deploy-dryrun-in-repo.log`, unchanged plan), a scratch
clone deploys itself (`railway up <appDir>`, `RAILWAY_DOCKERFILE_PATH=Dockerfile`,
standalone Dockerfile, clone-local `.dockerignore`).

## T2 — Cloud posture

Deployed, the template now leaves the store, connections and connectors slots
UNSET so one `VENDO_API_KEY` composes the hosted store and the Cloud broker,
and rides `vendoModel()` for the metered gateway. The spend middleware still
wraps that model (the README forbids removing it) and `connectorApps` scopes
the dock to `gmail`, `googlecalendar`, `slack`. `DEMO_STORE=local` pins the
local PGlite store for laptop dev, mirroring demo-bank's `MAPLE_STORE=local`.

`demo:deploy` now sets `VENDO_API_KEY` on the service when present and
requires at least one of it and `ANTHROPIC_API_KEY`; both are redacted in all
output.

**Gap, conductor-owned:** no live Cloud check. `flowlet/.env` carries
`ANTHROPIC_API_KEY`, `COMPOSIO_API_KEY`, `OPENAI_API_KEY`, `THESYS_API_KEY`,
`TAMBO_API_KEY` — no `VENDO_API_KEY`, which the contract says the conductor
provisions with the managed "Demos" project. The posture is proven at the
composition level (what `createVendo` receives), which is how demo-bank tests
its own.

## T3 — pills from the product

A `chips` stage after the rewrite reads the app's own `.vendo/tools.json` and
writes 4-5 pills into `demo.config.json` (one cheap model call, no judge
loop; auth routes filtered out — nobody demos `POST /api/auth/{nextauth}`).
Explicit beats win: a non-`TODO(creator): ` beat keeps its position and its
`expectsView`/`expectsApproval` contract, and derived pills fill to a cap of
five. A failed derivation is logged and the run continues on the rewrite's
own beats.

Live run over Maple's real 24-tool surface (22 after filtering), with the
template's placeholders in place — `ANTHROPIC_API_KEY` from
`~/orca/workspaces/flowlet/.env`:

| before (template placeholder) | after (derived from Maple's tools) |
|---|---|
| `TODO(creator): Dashboard of my data` | **Spending by category** — "Show me my spending by category for this month." |
| `TODO(creator): Archive an item, with approval` | **Recurring subscriptions** — "Show me all the recurring charges and subscriptions on my account." |
| `TODO(creator): Save this as an app` | **Send rent payment** — "Transfer $1,200 to my landlord from checking." |
| | **Savings goals progress** — "Show me the progress on all my savings goals." |
| | **Order dinner delivery** — "Order dinner delivery from my usual spot for tonight." |

Each names a capability Maple's extracted surface actually has (transfers,
savings goals, `host_createOrder`). Full output: `chips-live-demo.config.json`.

Accepted consequence: with the arc's three authored beats plus derived pills,
`demo-beats` capture now plays up to five beats instead of three (~2 extra
turns per run). Derived pills carry no expectation, so they only need to
settle cleanly.

## Reproducing

```sh
pnpm build                                    # vendoring packs what is on disk
pnpm --filter @vendoai/bench demo:create -- --id acme --prospect Acme
cd "$(node -p "require('node:path').join(require('node:os').tmpdir(),'vendo-demos','demo-acme')")"
pnpm install && pnpm build

# chips, against any app with a .vendo/tools.json
pnpm --filter @vendoai/bench demo:chips -- --app <APP_DIR>
```
