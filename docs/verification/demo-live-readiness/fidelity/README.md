# demo-fidelity — verification

Three changes so a generated prospect demo behaves like the real product, and
so building one can never leak a prospect's name into the OSS repo.

| Criterion | Verdict | Evidence |
|---|---|---|
| T1[1] default create target resolves outside the repo root | PASS | `bench/src/demo-creator/create.test.ts` "defaults the CTA and targets a scratch dir OUTSIDE the repo"; `scratch.test.ts` "defaultDemoScratchDir" |
| T1[1] `apps/demo-*` gitignored except the three real apps | PASS | `gitignore-check.log`; `scratch.test.ts` › "apps/demo-* gitignore" (runs real `git check-ignore`) |
| T1[2] a clone in the scratch location runs `pnpm build` green | PASS | `scratch-clone-build.log` — real clone at `<os-tmp>/vendo-demos/demo-fidelity-proof-d`, `pnpm install` + `pnpm build` from that directory, 8 routes emitted |
| T1 (narrative) the clone deploys from the scratch location | PARTIAL — plan proven, not executed | `deploy-dryrun-standalone.log`, `standalone-Dockerfile.txt`. No live Railway run: the contract forbids me deploying (the conductor deploys). |
| T2[1] `VENDO_API_KEY` + no explicit slots ⇒ hosted store + Cloud connections | PASS (real composition) | `server-config.test.ts` › "deployed: VENDO_API_KEY with no explicit slots RESOLVES the hosted store + Cloud connections" — runs the REAL `createVendo` and asserts the adapters it selected (`vendo.store` satisfies the runtime's hosted-store predicate; `vendo.connections.posture === "cloud"`). Not exercised against live Cloud: no `VENDO_API_KEY` exists yet (conductor provisions it). |
| T2[1] the local pin composes the local store | PASS (real composition) | same file, "local dev: DEMO_STORE=local RESOLVES a local store" — plus a keyless case proving neither composes without a key |
| T2[1] caps guard + spend middleware remain wired | PASS | same file, "keeps the caps guard + spend middleware wrapped around the model" |
| T3[1] N tools ⇒ chips referencing real capabilities | PASS | `chips-live-demo.config.json` — a LIVE derivation over Maple's real 24-tool surface, 5/5 pills surviving grounding with nothing culled. Enforced two ways: the cited tool names must exist, AND the visible chip+prompt must share a meaningful token with the cited capability's name/description (`chips.test.ts` › "DROPS a pill citing a real tool whose visible text is placeholder filler"). |
| T3[1] explicit beats override derived | PASS | `chips.test.ts` › `mergeBeats` + `runDeriveChips` "derives pills… kept 3, derived 2" |
| T3[1] empty/missing tools.json ⇒ NO chips, no crash | PASS | `chips.test.ts` › "derives NO chips with no tool surface" and "…when the surface holds only auth plumbing" — `chips` is `[]`, no model call, config untouched |
| T1 a failed standalone create is retryable | PASS | `create.test.ts` › "a failed standalone create is retryable" (3 cases: stale workspace leaves nothing behind, the retry then succeeds unaided, and a post-copy failure removes the partial clone) |

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
provisions with the managed "Demos" project.

What IS proven without one: the real `createVendo` runs under a dummy key and
the adapters it resolved are asserted — `vendo.store` against the runtime's own
hosted-store predicate, `vendo.connections.posture === "cloud"` — for the
deployed, local-pin and keyless cases. That is composition, not argument
inspection: unset slots are necessary but not sufficient, and what matters is
which adapter came out the other side. The test also captures the runtime's own
"Vendo Cloud is the hosted store for this deployment" warning as independent
confirmation. What remains for a live key is only the wire behind those
adapters — the console answering, and a real connect flow.

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
| `TODO(creator): Dashboard of my data` | **Show spending by category** — "Show me my spending by category for this period." |
| `TODO(creator): Archive an item, with approval` | **Show budget progress** — "Show my budgets and how much I've spent so far in each category." |
| `TODO(creator): Save this as an app` | **Send money to a friend** — "Transfer $50 from checking to Alex." |
| | **Order dinner delivery** — "Place a delivery order for dinner tonight." |
| | **List recurring subscriptions** — "List all my recurring charges and subscriptions." |

All five survived grounding and nothing was culled, which is the number that
matters: a stricter check is only worth having if it does not also throw away
good pills. Full output: `chips-live-demo.config.json`.

### How grounding works (deterministic, no judge model)

A cited tool name existing is NOT enough — that is the model's own say-so, and
filler like `c0`/`p0` attached to a real tool name would pass it. So each pill
faces two checks:

1. **Citation.** Every name in the pill's `tools` must exist in
   `.vendo/tools.json`.
2. **Lexical.** The visible chip + prompt and the cited capability's name +
   description are both normalized — camelCase split, lowercased, split on
   non-alphanumerics, stopwords and the `host_` prefix removed, trailing "s"
   folded — and must share at least one meaningful token.

camelCase splitting is load-bearing: tool names are `host_createOrder`, and
splitting on non-alphanumerics alone yields `createorder`, which matches no
human sentence. Two-character tokens are dropped as noise, which is also what
reduces `c0`/`p0` to nothing at all.

A pill failing either check is DROPPED and the reason logged. If that leaves
fewer than the target, the stage ships fewer — it never pads. A short strip of
pills that all work beats a full one carrying a pill that refuses when a
prospect clicks it.

Also hardened from this live run: the reply extractor no longer spans
first-brace to last-brace. A model answered, wrote "Wait, I need a single JSON
object", then emitted a corrected one — the old span swallowed all three
fragments and failed on valid output. It now scans complete top-level objects
(string- and escape-aware) and takes the last one carrying chips.

Accepted consequence: with the arc's three authored beats plus derived pills,
`demo-beats` capture now plays up to five beats instead of three (~2 extra
turns per run). Derived pills carry no expectation, so they only need to
settle cleanly.

## Checker rounds

Recorded here rather than in `progress.md`: that file is deliberately untracked
now, and this merge proved the point by replacing the working copy with another
lane's summary.

**Round 1 — 4 findings.**

| # | Finding | Fix |
|---|---|---|
| F1 (tamper) | Derivation validated JSON shape and count only, and the no-tools branch preserved existing beats instead of producing no chips | Pills must cite the tools they need; the no-tools branch yields `chips: []` and calls no model. Loose tests rewritten. |
| F2 | The T2 test mocked `createVendo` and inspected arguments only | Added a layer running the REAL `createVendo`, asserting the adapters it resolved. |
| F3 (real bug) | A failed standalone create left an unretryable partial clone | Freshness gate moved BEFORE the copy; any post-copy failure removes the clone. Three failure-path tests. |
| F4 (scope) | Files touched outside the pinned surfaces | The table below. |

**Round 2 — 1 finding (P0).** Round 1's grounding trusted the model's own
`tools` field: it verified the cited NAME existed but never that the visible
text had anything to do with it, so `c0`/`p0` filler citing a real tool passed.
The fixtures used exactly that shape, which is how it survived a round.
Grounding is now lexical and deterministic (see T3 above): a pill whose text
shares no meaningful token with its cited capability is dropped, and if that
leaves fewer than the target the stage ships fewer and never pads.

## Scope — every file touched outside the pinned surfaces

The contract pins `apps/demo-template` + `bench/src/demo-creator`. Three files
outside those are in the diff; here is each one and why.

| File | Change | Required by |
|---|---|---|
| `bench/src/demo-capture/hosts.ts` | `bootDemoHost` takes an optional `appDir` and, when the app is outside the repo, boots it from its own directory instead of `pnpm --filter <pkg>` at the repo root; the pre-boot key check accepts `VENDO_API_KEY` as well as `ANTHROPIC_API_KEY` (+21/−6) | **T1 and T2, strictly.** T1 moves the default clone outside the workspace, and a non-member cannot be booted by workspace filter — this is the only boot path the judge loop and the `demo-beats` capture have, so without it T1's own default breaks two pipeline stages. The key half is T2: a demo whose inference now rides `VENDO_API_KEY` would be refused at boot by a check that demanded a provider key. |
| `bench/src/demo-capture/capture.ts` | one line, passing `appDir` into `bootDemoHost` | **T1, strictly.** The call site for config-driven hosts; without it the parameter above is never supplied and `demo-beats` still cannot boot a scratch clone. |
| `packages/ui/src/chrome/chrome-css.ts` | comment only — a pointer to `LANE-REPORT.md` reworded | **NOT required by T1–T3.** It is required by the conductor's later hygiene directive: removing `LANE-REPORT.md` from the repo would otherwise leave this comment pointing at a file that no longer exists. Zero behavior change; the converged picks it referenced are enumerated inline directly below. Flagged rather than assumed — if the preference is a strictly T1–T3 diff, this one line reverts on its own, at the cost of a dangling reference. |

No other file outside the pinned surfaces is touched, except the repo-root
`.gitignore` (T1's own criterion) and the root scratch files the conductor
directed be removed.

## Rulings taken while building (nothing was weakened)

The contract left these to judgment; recording them here because the lane's
scratch `progress.md` is no longer tracked in the repo.

- **Vendoring over the two options the contract offered** — evidence at the
  top of the T1 section.
- **`demo:deploy` learned a second shape.** It used to refuse any app outside
  the repo, so moving the default target would have broken the pipeline at its
  last stage. In-repo apps keep today's plan byte-for-byte.
- **Deploy sets `VENDO_API_KEY`.** It only ever set `ANTHROPIC_API_KEY`, so the
  new Cloud posture would have reached a service with no usable key. It now
  sets whichever of the two is present and requires at least one.
- **The clone carries the root's security floors.** A standalone project
  inherits none of the monorepo's pnpm settings, and the template pins
  `next: 16.2.9` — below the root's `>=16.2.11` advisory floor.
- **"Explicit wins" resolved per beat, not per config.** The pipeline's `beats`
  agent authors all three arc beats, so a strict reading would make derivation
  a permanent no-op. Non-placeholder beats are kept verbatim and first; derived
  pills fill to a cap of five.
- **A failed derivation does not sink a run.** It logs and continues on the
  rewrite's beats — a wrong pill is a confusing chip, not a broken demo.

## Gate

`pnpm build && pnpm test && pnpm typecheck && pnpm lint`, green twice on the
committed code. Run **serially** (`--concurrency=1`): at default turbo
concurrency the suite failed twice on this machine in *different* untouched
packages (`@vendoai/apps`, then `@vendoai-examples/mastra-agent`), each of
which passes standalone, with load average 42 from other lanes running
concurrently.

## Reproducing

```sh
pnpm build                                    # vendoring packs what is on disk
pnpm --filter @vendoai/bench demo:create -- --id acme --prospect Acme
cd "$(node -p "require('node:path').join(require('node:os').tmpdir(),'vendo-demos','demo-acme')")"
pnpm install && pnpm build

# chips, against any app with a .vendo/tools.json
pnpm --filter @vendoai/bench demo:chips -- --app <APP_DIR>
```
