# OSS corpus

The corpus exercises `vendo init` against pinned open-source Next.js apps we do
not own. Corpus repos are cloned on demand under `corpus/.repos/`, which is
gitignored; do not commit foreign repo code or generated run artifacts.

## Commands

- `pnpm corpus --help` prints the current harness commands.
- `pnpm corpus validate` loads and validates `corpus/manifest.json`.
- `pnpm corpus list` prints the pinned repos in the manifest.
- `pnpm corpus run [repo...] --layer 1` runs the Layer 1 sweep for the selected
  repos, or every manifest repo when none are named.
- `pnpm corpus run [repo...] --layer 2` adds scoring against the checked-in
  expectations for the selected development repos.
- `pnpm --filter @vendoai/corpus-harness test` runs the harness unit tests.

Run artifacts are written under `corpus/.repos/.logs/`, with a copy of the
aggregate scorecard under each selected repo's `run/` directory. The runner
invokes the built umbrella CLI as `vendo init <repo> --yes`, after local package
injection. Pass `--json` to print the machine-readable scorecard, and
`--strict` to make hard failures return a nonzero exit code. Without `--strict`,
the sweep reports all repo failures and exits 0.

## Local Vendo injection

The harness owns the local-pack boundary. Once per sweep it builds the workspace
and packs the v0 publish set: `@vendoai/core`, `store`, `agent`, `actions`,
`guard`, `apps`, `automations`, `ui`, `telemetry`, `mcp`, `vendo`, plus the `vendoai`
alias. Each cloned app receives the cached tarballs under `vendor/`, depends on
the bin-owning `@vendoai/vendo` umbrella, and pins the complete workspace closure
to `file:vendor/*.tgz` through its package-manager resolution field. The harness
then runs the app's non-frozen install and invokes `vendo init --yes` through the
built `packages/vendo` CLI.

Known local-pack hazard: paths containing spaces are rejected up front by the
harness. Keep both the Vendo workspace path and `corpus/.repos/<name>/` paths
space-free.

## Local hosts

Manifest entries may use `localPath` instead of `gitUrl` plus `pinnedSha`. The
path is relative to the Vendo repo root; each run copies it into `.repos/`,
omits generated/dependency trees, and creates a fresh one-commit Git snapshot
for the same init-idempotency checks used by external repos. `express-host` is
the permanent proof that the framework-agnostic handler claim in contracts 09
§2 survives all three corpus layers, including a live `vendo doctor` check.

## Manifest

`corpus/manifest.json` is a JSON array. Each entry has:

- `name`: stable lowercase repo identifier.
- Source: either `gitUrl` plus a 40-character `pinnedSha`, or a repo-relative
  `localPath`; the two forms are mutually exclusive.
- `framework`: optional `next` or `express` structural wiring mode; defaults to
  `next`.
- `license`: SPDX identifier or a documented best-effort license string.
- `tier`: `broad` or `deep`.
- `bootstrap`: install command, env template, optional seed command, build
  command, and for `deep` repos a dev-server command plus readiness URL.
- `notes`: optional verification notes.

Env template values are either literals or secret placeholders such as
`${CORPUS_UMAMI_DATABASE_URL}`. Later bootstrap code resolves placeholders from
the orchestrating environment; Vendo-specific wiring never belongs here.

## Adding a repo

1. Verify the default branch, HEAD SHA, license, and current Next.js stack with
   the GitHub API or `git ls-remote`.
2. Add one manifest entry pinned to the verified SHA.
3. Use the repo's lockfile to choose `pnpm install --frozen-lockfile`,
   `npm ci`, or the equivalent install command.
4. Copy only host-app setup needs into `envTemplate`; never add Vendo-specific
   env vars or code.
5. Run `pnpm corpus validate` and the harness tests.

## Continuous integration

The `Corpus Nightly` workflow (`.github/workflows/corpus-nightly.yml`) runs the
development sweep on a schedule (08:00 UTC daily) and on demand via
`workflow_dispatch` (inputs: `repos` space-separated filter, `layer` 1/2). It builds the
workspace, runs `pnpm corpus run --json`, writes the scorecard to the job
summary, appends a trend delta versus the previous run
(`corpus/scripts/corpus-trend.mjs`), and uploads `scorecard.json` + `.md` +
per-repo logs as the `corpus-scorecard` artifact (30-day retention).

PR CI is untouched — no LLM cost or flakiness is added to the merge path.

Required secrets (Settings → Secrets and variables → Actions):

- `ANTHROPIC_API_KEY` (required) — real `vendo init` extraction needs an LLM
  key. The workflow fails fast if it is missing.
- `OPENAI_API_KEY` (optional) — alternate provider.
- `CORPUS_<REPO>_<KEY>` — per-repo bootstrap secrets referenced as
  `${CORPUS_<REPO>_<KEY>}` placeholders in a manifest `envTemplate`.

Run a filtered sweep on demand from the Actions tab → Corpus Nightly → Run
workflow, e.g. `repos: umami taxonomy`, `layer: 1`.
