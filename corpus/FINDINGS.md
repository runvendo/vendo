# Corpus Findings

Date: 2026-07-06
Command: `pnpm corpus run --layer 1`
Mode: real `vendo init` with LLM enabled. API keys were sourced from `apps/demo-bank/.env.local`; key values were not printed or committed.
Scorecard artifacts: `corpus/.repos/.logs/scorecard.json` and `corpus/.repos/.logs/scorecard.md`
Latest scorecard: `2026-07-06T16:53:16.265Z`

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
| cal-com | FAIL | 4/7 | `host.typecheck`, `host.build`, `init.idempotent` |

## Cross-Repo CLI Findings

### HARNESS-001: cal-com Yarn local package injection now completes

The harness now supports Yarn local package injection for `cal-com`. The injector rewrites `apps/web/package.json` dependencies to `file:vendor/*.tgz`, adds Yarn `resolutions`, adds matching root workspace `resolutions` with `file:apps/web/vendor/*.tgz`, and refreshes `yarn.lock` with immutable installs disabled. Both `vendo init` runs completed and reported Yarn `resolutions` plus `YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install`.

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

Layer 1 result: FAIL, 4/7.

Passed checks: `init.exit`, `files.expected`, `config.schema`, `tools.fail-closed`.

Findings:

- Yarn local injection succeeded. `apps/web/package.json` uses `file:vendor/*.tgz`, the workspace root uses `resolutions` pointing at `file:apps/web/vendor/*.tgz`, and both init logs report `resolutions` with `YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install`.
- CLI dependency compatibility: Cal.com's post-init TypeScript check and Next build cannot resolve `vendoai/server` and `vendoai/react` subpath types under its current TypeScript `moduleResolution`. The baseline typecheck/build both passed before init.
- CLI-002-style idempotency still fails; the second init exits 0, but refreshed local tarballs produce binary diffs under `apps/web/vendor/`.
- CLI extraction robustness: route enrichment fell back to deterministic route inventory after fenced LLM JSON failed schema validation. Init still exited 0 and generated `81` tools.

Repro:

```sh
pnpm corpus run cal-com --layer 1
cd corpus/.repos/cal-com && corepack yarn turbo run type-check --filter=@calcom/web...
```

Logs: `corpus/.repos/.logs/cal-com/init.first.log`, `structural.typecheck.stdout.log`, `structural.build.stdout.log`, and `init.second.diff`.

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
