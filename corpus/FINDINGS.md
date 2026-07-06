# Corpus Findings

Date: 2026-07-06
Command: `pnpm corpus run --layer 1`
Mode: real `vendo init` with LLM enabled. API keys were sourced from `apps/demo-bank/.env.local`; key values were not printed or committed.
Scorecard artifacts: `corpus/.repos/.logs/scorecard.json` and `corpus/.repos/.logs/scorecard.md`

## Summary Scorecard

| Repo | Layer 1 | Score | Hard failures |
| --- | --- | ---: | --- |
| umami | FAIL | 4/7 | `host.typecheck`, `host.build`, `init.idempotent` |
| skateshop | FAIL | 4/7 | `host.typecheck`, `host.build`, `init.idempotent` |
| taxonomy | FAIL | 4/7 | `host.typecheck`, `host.build`, `init.idempotent` |
| invoify | FAIL | 3/7 | `files.expected`, `host.typecheck`, `host.build`, `init.idempotent` |
| papermark | FAIL | 4/7 | `host.typecheck`, `host.build`, `init.idempotent` |

## Cross-Repo CLI Findings

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

Logs: `corpus/.repos/.logs/<repo>/structural.build.stderr.log`.

### CLI-002: `vendo init` is not idempotent

Running `vendo init` a second time exits nonzero because `.vendo/theme.json` already exists and the CLI requires `--force` to overwrite developer-editable output. The Layer 1 idempotency check therefore fails across all repos.

Affected repos: `umami`, `skateshop`, `taxonomy`, `invoify`, `papermark`.

Repro:

```sh
pnpm corpus run <repo> --layer 1
```

Logs: `corpus/.repos/.logs/<repo>/init.second.log` and `corpus/.repos/.logs/<repo>/init.second.diff`.

## umami

Layer 1 result: FAIL, 4/7.

Passed checks: `init.exit`, `files.expected`, `config.schema`, `tools.fail-closed`.

Findings:

- CLI-001 blocks `host.build`; `prebuild` resolves the wrong `vendo` executable.
- CLI-002 blocks `init.idempotent`; the second init refuses existing `.vendo/theme.json`.
- CLI extraction robustness: the LLM route scan returned fenced JSON that failed schema validation, after which route scan fallback and component discovery were skipped. Init still exited 0 but generated `0` tools.
- Host prerequisite: raw `pnpm --ignore-workspace exec tsc --noEmit` fails on missing generated Prisma client imports and existing TypeScript errors.

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
- CLI artifact leakage: generated `public/vendo/react-runtime.js` is picked up by the repo's TypeScript command, causing `host.typecheck` to fail on bundled runtime JavaScript.

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

Layer 1 result: FAIL, 3/7.

Passed checks: `init.exit`, `config.schema`, `tools.fail-closed`.

Findings:

- CLI-001 blocks `host.build`; `prebuild` resolves the wrong `vendo` executable.
- CLI-002 blocks `init.idempotent`; the second init refuses existing `.vendo/theme.json`.
- CLI layout rewrite gap: init skipped `app/layout.tsx` because it could not find exactly one `{children}` expression, so `files.expected` failed because the layout was not wrapped with `AppVendoRoot`.
- Host prerequisite: raw `npm exec tsc -- --noEmit` fails on missing asset module declarations for favicon, invoice PNGs, and SVG logo imports.

Repro:

```sh
pnpm corpus run invoify --layer 1
```

Logs: `corpus/.repos/.logs/invoify/init.first.log`, `structural.typecheck.stdout.log`, `structural.build.stderr.log`, and `init.second.log`.

## papermark

Layer 1 result: FAIL, 4/7.

Passed checks: `init.exit`, `files.expected`, `config.schema`, `tools.fail-closed`.

Findings:

- CLI-001 blocks `host.build`; `prebuild` resolves the wrong `vendo` executable.
- CLI-002 blocks `init.idempotent`; the second init refuses existing `.vendo/theme.json`.
- Host prerequisite: raw `npm exec tsc -- --noEmit` fails on existing enterprise-module and asset-module resolution errors.
- CLI config-loading robustness: init warned that `tailwind.config.js` could not be loaded in ESM scope because `module is not defined`, but init continued and generated tools.

Repro:

```sh
pnpm corpus run papermark --layer 1
```

Logs: `corpus/.repos/.logs/papermark/init.first.log`, `structural.typecheck.stdout.log`, `structural.build.stderr.log`, and `init.second.log`.
