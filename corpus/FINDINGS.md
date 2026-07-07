# Corpus Findings

## Batch B Extraction Generalization Campaign

Date: 2026-07-06 (evening)
Command: `pnpm corpus run --layer 2 --json` (all 12 repos, real `vendo init`
with LLM enabled; keys sourced from `apps/demo-bank/.env.local`, values not
printed or committed).
Scorecard: `corpus/.repos/.logs/scorecard.{json,md}`.

**Result: Layer 2 is 10/10 on all 12 repos — every Batch B repo joined the
dev set at the bar, with zero Layer 2 hard failures and no Batch A
regression.**

| Repo | Layer 2 before | Layer 2 after |
| --- | ---: | ---: |
| cal-com | 0.99 | 10/10 |
| dub | 3.10 | 10/10 |
| formbricks | 5.0 | 10/10 |
| inbox-zero | 10.0 | 10/10 |
| openstatus | 4.0 | 10/10 |
| teable | scorer hard-fail → 4.0 | 10/10 |
| vercel-commerce | 5.0 | 10/10 |
| umami / skateshop / taxonomy / invoify / papermark | 10/10 | 10/10 |

What moved the scores (details in the PR):

- **LABEL-001 (fixed)**: Batch B labels marked side-effect-free GETs
  `readOrWrite: "read"`, violating the write-always route-scan convention this
  directory's README documents (Batch A labels contain zero GET-reads). On
  inbox-zero and formbricks every single tool miss was this flip. Normalized
  by `corpus/scripts/normalize-batch-b-labels.py`; the fail-closed extractor
  invariant was NOT touched.
- **LABEL-002 (fixed)**: dub's inventory covered only `app/api/**` and skipped
  the 348 served route files under `app/(ee)/api/**`; relabeled from pinned
  source (215 → 617 tools; HEAD/OPTIONS excluded as non-agent verbs). teable
  gained its second real Pages API route (`GET /api/_monitor/sentry`).
- **CLI (route-scan)**: star/named re-exports, aliased default re-exports with
  tsconfig `paths`, `defaultHandler({...})` method maps, tRPC
  `createNextApiHandler`, webhook-POST tiebreak for pages default exports.
- **CLI (theme)**: CSS `@import` chain following (incl. workspace packages
  outside the app dir), entry-graph CSS priority over the blind walk, RGB
  triplets/`hsla()`, geist/@fontsource/next-font-inline recovery, Tailwind
  config source parsing, and utility-class inference of last resort (dominant
  muted-text utility; raw-palette monochrome/white-card fallbacks that never
  override declared token systems).

Remaining Layer 1 items on this run — all pre-existing, none Layer 2, none
introduced by the campaign diff:

- `init.idempotent` (umami, invoify, inbox-zero): LLM component discovery is
  additive-nondeterministic across runs — a component that failed schema
  generation on run 1 lands on run 2, so the second-run diff is non-empty.
  Harness policy question: additive `.vendo/components/` gap-fill is designed
  behavior; the check may want to ignore new component dirs.
- `host.typecheck` (skateshop): the repo's `tsconfig` sweeps
  `public/vendo/*.js` bundled runtime assets into `tsc` (known since the
  first sweep).
- `host.build` (skateshop, taxonomy): contentlayer/webpack failures inside the
  pinned repos' own toolchains after any dependency graph change.
- `files.expected` (invoify): root layout has no single `{children}`
  expression, so init fail-closes on the wrap (documented CLI behavior).
- `files.expected` (teable): Pages Router apps aren't auto-wired
  (`AppVendoRoot`/sandbox assets are manual there) — tracked CLI follow-up.


Command: `pnpm corpus run --layer 1`
Mode: real `vendo init` with LLM enabled. API keys were sourced from `apps/demo-bank/.env.local`; key values were not printed or committed.
Scorecard artifacts: `corpus/.repos/.logs/scorecard.json` and `corpus/.repos/.logs/scorecard.md`
Latest scorecard: `2026-07-06T17:17:37.889Z`

## Task 9 Manifest Substitution

- `plane` was not added because `makeplane/plane` default branch `preview` is no longer a Next.js app: the current web package builds with React Router (`react-router build`) and the tree only keeps `app/compat/next` compatibility shims. It was substituted with `teable`, a comparable collaborative OSS app whose `apps/nextjs-app` package is a current Next.js app.

## Summary Scorecard

| Repo | Layer 1 | Score | Hard failures |
| --- | --- | ---: | --- |
| umami | FAIL | 5/7 | `host.build`, `init.idempotent` |
| skateshop | FAIL | 4/7 | `host.typecheck`, `host.build`, `init.idempotent` |
| taxonomy | FAIL | 4/7 | `host.typecheck`, `host.build`, `init.idempotent` |
| invoify | FAIL | 4/7 | `files.expected`, `host.build`, `init.idempotent` |
| papermark | FAIL | 4/7 | `host.typecheck`, `host.build`, `init.idempotent` |
| cal-com | PASS | 7/7 | none |

## Cross-Repo CLI Findings

### HARNESS-001: cal-com Yarn local package injection and init now pass

The harness now supports Yarn local package injection for `cal-com`. The injector rewrites `apps/web/package.json` dependencies to `file:vendor/*.tgz`, adds Yarn `resolutions`, adds matching root workspace `resolutions` with `file:apps/web/vendor/*.tgz`, and refreshes `yarn.lock` with immutable installs disabled. Both `vendo init` runs complete and report Yarn `resolutions` plus `YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install`.

Follow-up verification on 2026-07-06: Cal.com's `apps/web/tsconfig.json` extends `@calcom/tsconfig/nextjs.json`, which extends `@calcom/tsconfig/base.json` and sets `moduleResolution: "node"`. Vendo's package metadata now exposes `vendoai/server` and `vendoai/react` to that Node10 resolver, and the harness ignores regenerated `vendor/*.tgz` bytes in the second-run idempotency diff. The fresh Layer 1 scorecard passes 7/7.

Repro:

```sh
pnpm corpus run cal-com --layer 1
```

Logs: `corpus/.repos/.logs/cal-com/init.first.log`, `init.second.log`, and `yarn.lock` in the disposable checkout.

### CLI-001: Generated `prebuild` calls cannot find the intended Vendo CLI

`vendo init` injects `prebuild: "vendo sync"` into host apps, but the sweep clones do not get a guaranteed local `vendo` binary on `PATH`. During builds, the shell resolved an unrelated global Python `vendo` command and failed with `ModuleNotFoundError: No module named 'vendo_swarm'`.

Affected repos: `umami`, `skateshop`, `taxonomy`, `invoify`, `papermark`.

Repro:

```sh
pnpm corpus run --layer 1
```

Or from any initialized corpus clone:

```sh
cd corpus/.repos/<repo>
<package-manager> run build
```

Logs: `corpus/.repos/.logs/<repo>/structural.build.stderr.log`. Papermark's `host.typecheck` also hits this because the repo has no native standalone typecheck script, so the manifest uses its package build as the closest app-native validation command.

### CLI-002: `vendo init` is not idempotent

Running `vendo init` a second time exits nonzero because `.vendo/theme.json` already exists and the CLI requires `--force` to overwrite developer-editable output. The Layer 1 idempotency check therefore fails across all repos.

Affected repos: `umami`, `skateshop`, `taxonomy`, `invoify`, `papermark`.

Repro:

```sh
pnpm corpus run <repo> --layer 1
```

Logs: `corpus/.repos/.logs/<repo>/init.second.log` and `corpus/.repos/.logs/<repo>/init.second.diff`.

## cal-com

Layer 1 result: PASS, 7/7.

Passed checks: `init.exit`, `files.expected`, `config.schema`, `host.typecheck`, `host.build`, `init.idempotent`, `tools.fail-closed`.

Findings:

- Yarn local injection succeeded. `apps/web/package.json` uses `file:vendor/*.tgz`, the workspace root uses `resolutions` pointing at `file:apps/web/vendor/*.tgz`, and both init logs report `resolutions` with `YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install`.
- CLI dependency compatibility fixed: Cal.com's post-init TypeScript check and Next build now resolve `vendoai/server` and `vendoai/react` under its inherited `moduleResolution: "node"` config.
- Harness idempotency fixed: the second init exits 0 and `init.second.diff` is empty after excluding regenerated `vendor/*.tgz` tarballs from the second-run diff.
- CLI extraction robustness: route enrichment fell back to deterministic route inventory after fenced LLM JSON failed schema validation. Init still exited 0 and generated `81` tools.

Repro:

```sh
pnpm corpus run cal-com --layer 1
cd corpus/.repos/cal-com && corepack yarn turbo run type-check --filter=@calcom/web...
```

Logs: `corpus/.repos/.logs/cal-com/init.first.log`, `init.second.diff`, `structural.typecheck.stdout.log`, and `structural.build.stdout.log`.

## umami

Layer 1 result: FAIL, 5/7.

Passed checks: `init.exit`, `files.expected`, `config.schema`, `host.typecheck`, `tools.fail-closed`.

Findings:

- CLI-001 blocks `host.build`; `prebuild` resolves the wrong `vendo` executable.
- CLI-002 blocks `init.idempotent`; the second init refuses existing `.vendo/theme.json`.
- CLI extraction robustness: the LLM route scan returned fenced JSON that failed schema validation, after which route-scan fallback and component discovery were skipped. Init still exited 0 but generated `0` tools.

Recipe fixes applied: the manifest now generates the Prisma client before Umami's raw TypeScript check, and the typecheck passes.

Repro:

```sh
pnpm corpus run umami --layer 1
```

Logs: `corpus/.repos/.logs/umami/init.first.log`, `structural.typecheck.stdout.log`, and `structural.build.stderr.log`.

## skateshop

Layer 1 result: FAIL, 4/7.

Passed checks: `init.exit`, `files.expected`, `config.schema`, `tools.fail-closed`.

Findings:

- CLI-001 blocks `host.build`; `prebuild` resolves the wrong `vendo` executable.
- CLI-002 blocks `init.idempotent`; the second init refuses existing `.vendo/theme.json`.
- CLI artifact leakage: generated `public/vendo/components-sandbox.js` and `public/vendo/react-runtime.js` are picked up by the repo's TypeScript command, causing `host.typecheck` to fail on bundled runtime JavaScript.

Repro:

```sh
pnpm corpus run skateshop --layer 1
cd corpus/.repos/skateshop && pnpm --ignore-workspace typecheck
```

Logs: `corpus/.repos/.logs/skateshop/structural.typecheck.stdout.log`, `structural.build.stderr.log`, and `init.second.log`.

## taxonomy

Layer 1 result: FAIL, 4/7.

Passed checks: `init.exit`, `files.expected`, `config.schema`, `tools.fail-closed`.

Findings:

- CLI-001 blocks `host.build`; `prebuild` resolves the wrong `vendo` executable.
- CLI-002 blocks `init.idempotent`; the second init refuses existing `.vendo/theme.json`.
- CLI dependency compatibility: after local Vendo injection, the repo's pinned TypeScript 4.7.4 fails parsing newer `zod` declaration files pulled into the dependency graph.

Repro:

```sh
pnpm corpus run taxonomy --layer 1
cd corpus/.repos/taxonomy && pnpm --ignore-workspace exec tsc --noEmit
```

Logs: `corpus/.repos/.logs/taxonomy/structural.typecheck.stdout.log`, `structural.build.stderr.log`, and `init.second.log`.

## invoify

Layer 1 result: FAIL, 4/7.

Passed checks: `init.exit`, `config.schema`, `host.typecheck`, `tools.fail-closed`.

Findings:

- CLI-001 blocks `host.build`; `prebuild` resolves the wrong `vendo` executable.
- CLI-002 blocks `init.idempotent`; the second init refuses existing `.vendo/theme.json`.
- CLI layout rewrite gap: init skipped `app/layout.tsx` because it could not find exactly one `{children}` expression, so `files.expected` failed because the layout was not wrapped with `AppVendoRoot`.

Recipe fixes applied: the manifest now uses the app-native Next build for type validation instead of raw `tsc`, which cannot resolve Next image imports in this repo.

Repro:

```sh
pnpm corpus run invoify --layer 1
```

Logs: `corpus/.repos/.logs/invoify/init.first.log`, `structural.typecheck.stdout.log`, `structural.build.stderr.log`, and `init.second.log`.

## papermark

Layer 1 result: FAIL, 4/7.

Passed checks: `init.exit`, `files.expected`, `config.schema`, `tools.fail-closed`.

Findings:

- CLI-001 blocks `host.typecheck` and `host.build`; both use the repo package build path, whose `prebuild` resolves the wrong `vendo` executable.
- CLI-002 blocks `init.idempotent`; the second init refuses existing `.vendo/theme.json`.
- CLI config-loading robustness: init warned that `tailwind.config.js` could not be loaded in ESM scope because `module is not defined`, but init continued and generated tools.

Recipe fixes applied: the manifest now supplies a dummy `NEXT_PUBLIC_WEBHOOK_BASE_HOST` so Papermark's Next config does not emit an invalid host-header rule.

Repro:

```sh
pnpm corpus run papermark --layer 1
```

Logs: `corpus/.repos/.logs/papermark/init.first.log`, `structural.typecheck.stderr.log`, `structural.build.stderr.log`, and `init.second.log`.

## Batch B Ground-Truth Labels

Date: 2026-07-06
Command: `pnpm corpus run <repo> --layer 2 --json`
Mode: real `vendo init` with LLM enabled. API keys were sourced from `apps/demo-bank/.env.local`; key values were not printed or committed.

Labels were derived from pinned source at the manifest SHA, not from generated `.vendo` output. Monorepos were labeled from the manifest `appDir`.

| Repo | expected.json | Tools | Layer 2 | Baseline |
| --- | --- | ---: | --- | --- |
| cal-com | written | 114 | skipped before scoring: Yarn local package injection is unsupported | none |
| dub | written | 215 | skipped before scoring: appDir `pnpm install --ignore-workspace` failed | none |
| formbricks | written | 120 | skipped before scoring: frozen lockfile override mismatch during bootstrap | none |
| inbox-zero | written | 194 | skipped before scoring: frozen lockfile override mismatch during bootstrap | none |
| openstatus | written | 8 | skipped before scoring: frozen lockfile catalog mismatch during bootstrap | none |
| vercel-commerce | written | 1 | pass, 1/10 (0.1) | written |
| teable | written | 1 | skipped before scoring: appDir `pnpm install --ignore-workspace` failed | none |

Notes:

- `cal-com` was labeled from `apps/web` source anyway, including App Router API routes plus legacy Pages API bridges. Layer 2 was not scored because the harness fails closed on Yarn package injection.
- `vercel-commerce` scored only the radius rubric point. Generated output used the default theme and generated no matching tools, while the source label expects `POST /api/revalidate`.

### Batch B Follow-Up Layer 2 Bootstrap Fixes

Date: 2026-07-06
Command: `pnpm corpus run dub formbricks inbox-zero openstatus teable vercel-commerce --layer 2 --json`, after harness bootstrap/injection install normalization.
Mode: real `vendo init` with env sourced from `apps/demo-bank/.env.local`; key values were not printed or committed.

| Repo | Layer 2 | Baseline |
| --- | --- | --- |
| dub | pass, 3/10 (0.3) | written |
| formbricks | pass, 3/10 (0.3) | written |
| inbox-zero | pass, 3/10 (0.3) | written |
| openstatus | pass, 1/10 (0.1) | written |
| teable | scorer failed: `.vendo/tools.json` was not generated because the app has only route-group App Router roots (`app/(...)`) and no `app/layout.*` or `src/app/layout.*` root layout for auto-wiring | none |

Notes:

- The harness now degrades frozen pnpm/npm install recipes before mutable installs and runs pnpm appDir injection installs from the repo workspace root so `workspace:` and `catalog:` protocols resolve.
- Post-injection pnpm installs use local-install policy overrides for `minimumReleaseAge` and dependency build approval so local tarballs can be installed in supply-chain-hardened repos without editing their manifests.
