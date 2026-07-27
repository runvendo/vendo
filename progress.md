# RUN SUMMARY — demo-fidelity (`factory/demo-fidelity`)

> The lane's run summary, verbatim and committed (replacing the previous
> lane's, per the factory convention). Full evidence:
> `docs/verification/demo-live-readiness/fidelity/`.

**Impact.** Three things change for prospect demos. (1) Building one can no
longer leak: clones land outside this checkout, and `apps/demo-*` is
gitignored for the case where someone still puts one there — a generated demo
is a named prospect's logo, palette and copy, and it was one `git add -A` from
the public repo. (2) A deployed demo is a real Cloud tenant: one
`VENDO_API_KEY` now composes the hosted store and the connections broker, so
"connect your Gmail" works and state survives a redeploy — neither did before.
(3) The example pills a prospect clicks are derived from the demo's own
extracted tool surface instead of invented by an agent, so they name things
the demo can actually do.

## The finding that changed the plan

The contract offered two ways to make an out-of-repo clone resolve its
`workspace:*` deps: symlink the workspace packages, or pin the published
`@vendoai/*` versions. Both are wrong, and I only found out by trying:

- **Published pins fail today.** Workspace `@vendoai/vendo@0.4.8` exports
  `vendoModel`; *published* `0.4.8` does not. main runs ahead of the registry
  at the same version string between releases, so a pinned clone fails to
  build now and would demo a release-old Vendo even once it built. That also
  kills T2 — the Cloud gateway rung lives in the unreleased code.
- **Symlinks cannot be deployed.** They build on a laptop and cannot be
  uploaded to Railway, so `demo:deploy` would stay broken.

So the clone **vendors** this tree: `demo:create` `pnpm pack`s the fourteen
publishable `@vendoai/*` packages into the clone's `vendor/` (~6MB, ~10s) and
forces them transitively through the clone's own `pnpm-workspace.yaml`
overrides. The demo runs the exact Vendo the monorepo was at when it was
generated, which is what "behave like the real product" has to mean.

## Per-task status

| Task | Status | Proof |
|---|---|---|
| T1 Build outside the repo (leak fix) | **done** | Real clone at `<os-tmp>/vendo-demos/demo-fidelity-proof-d` installs and builds green (`scratch-clone-build.log`, 8 routes). `git check-ignore` passes for `apps/demo-*` and fails for the three real apps. |
| T2 Cloud posture in the template | **done, one gap** | Store/connections/connectors UNSET, model on `vendoModel()`, spend middleware still wrapping, `connectorApps` scoped to gmail/googlecalendar/slack, `DEMO_STORE=local` for laptops. Composition-level tests, as demo-bank does. No live Cloud check — see gaps. |
| T3 Pills from the product | **done** | Live derivation over Maple's real 24-tool surface turned three `TODO(creator):` placeholders into five Maple-specific pills (spending by category, recurring subscriptions, rent transfer, savings goals, dinner delivery). |

## Contract criteria

1. **Default create target resolves outside the repo root.** PASS — `<os-tmp>/vendo-demos/demo-<id>`, asserted absolute AND outside the repo.
2. **`apps/demo-*` gitignored except the three real ones; test asserts `git check-ignore` succeeds.** PASS — `scratch.test.ts` › "apps/demo-* gitignore" shells out to real `git check-ignore` for both directions.
3. **A clone in the scratch location runs `pnpm build` green.** PASS — live, `scratch-clone-build.log`.
4. **With `VENDO_API_KEY` and no explicit store/connectors, the composed server resolves hosted store + Cloud connections.** PASS at composition level (`server-config.test.ts`), mirroring demo-bank's own posture test. Not exercised against live Cloud — no key exists yet.
5. **With the local pin set, it composes the local store.** PASS.
6. **Caps guard + spend middleware remain wired.** PASS — regression test asserts the model handed to `createVendo` is the wrapped one.
7. **N tools ⇒ 4-5 chips referencing real tool capabilities.** PASS — live run above; the derivation refuses a reply too thin to fill the strip rather than shipping two pills.
8. **Explicit beats override derived.** PASS — non-placeholder beats keep their position and their `expectsView`/`expectsApproval` contract; derived pills fill to five.
9. **Empty/missing tools.json ⇒ no chips, no crash.** PASS — no model call, config untouched.
10. **`pnpm build && pnpm test && pnpm typecheck && pnpm lint` green twice.** See "Gate" below.

## Rulings I made (contract said park or decide; nothing was weakened)

- **Vendoring over the two offered options** — evidence above.
- **`demo:deploy` learned a second shape.** It used to refuse any app outside
  the repo, so moving the default target would have broken the pipeline at
  the last stage. In-repo apps keep today's plan byte-for-byte; a scratch
  clone deploys itself (`railway up <appDir>`, standalone Dockerfile,
  clone-local `.dockerignore`). Proven by dry-run plans for both shapes, not
  by a live deploy — the contract forbids me deploying.
- **Deploy sets `VENDO_API_KEY`.** It only ever set `ANTHROPIC_API_KEY`, so
  the new Cloud posture would have had no key on the service. It now sets
  whichever of the two is present and requires at least one.
- **The clone carries the root's security floors.** A standalone project
  inherits none of the monorepo's pnpm settings, and the template pins
  `next: 16.2.9` — below the root's `>=16.2.11` advisory floor. The generated
  `pnpm-workspace.yaml` copies `overrides` + `allowBuilds` verbatim.
- **"Explicit wins" resolved per beat, not per config.** The pipeline's
  `beats` agent authors all three arc beats, so a strict reading would make
  derivation a permanent no-op. Non-placeholder beats are kept verbatim and
  first; derived pills fill to a cap of five. Accepted consequence: capture
  plays up to five beats instead of three (~2 extra turns), and derived pills
  carry no expectation so they only need to settle.
- **A failed derivation does not sink a run.** It logs and continues on the
  rewrite's beats — a wrong pill is a confusing chip, not a broken demo.

## Gaps (conductor-owned)

- **No live Cloud verification of T2.** `flowlet/.env` has no `VENDO_API_KEY`
  — per the contract, the conductor provisions the managed "Demos" project and
  the key. Once it exists, the check is: deploy a scratch clone, open the
  connect dock, confirm the three toolkits appear, and confirm thread state
  survives a redeploy.
- **No live Railway deploy of a standalone clone.** Forbidden to me; the
  command plan and the Dockerfile are in the evidence folder for whoever runs
  it.
- **`apps/demo-template/.vendo/tools.json` refreshed** from `vendo/tools@1` to
  `@3` as a side effect of `pnpm build` (the committed file was stale on main,
  unrelated to this lane). Committed rather than left dirtying the tree.

## Gate

`pnpm build`, `pnpm typecheck` and `pnpm lint` are green. `pnpm test` at
default turbo concurrency failed twice on this machine in *different*
packages I never touched (`@vendoai/apps`, then
`@vendoai-examples/mastra-agent`), each of which passes standalone; load
average was 42 from other factory lanes running concurrently. The gate is
therefore run serially (`--concurrency=1`).
