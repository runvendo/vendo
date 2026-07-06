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
- `pnpm --filter @vendoai/corpus-harness test` runs the harness unit tests.

Run artifacts are written under `corpus/.repos/.logs/`, with a copy of the
aggregate scorecard under each selected repo's `run/` directory. By default the
runner invokes real `vendo init` with LLM steps enabled; pass `--skip-llm` for
cheap harness runs. Pass `--json` to print the machine-readable scorecard, and
`--strict` to make hard failures return a nonzero exit code. Without `--strict`,
the sweep reports all repo failures and exits 0.

## Local Vendo injection

The Vendo CLI's existing local/dev mode is:

```sh
vendo init [dir] --local <vendo-monorepo>
```

`--local=<vendo-monorepo>` is equivalent. That mode calls the CLI's
`installLocalVendoPackages()` path, packing local `@vendoai/*` workspace
packages and rewriting the host app to `file:vendor/*.tgz` dependencies and
overrides. The corpus harness reuses that local-pack mechanism and caches the
packed tarballs once per sweep before copying them into each repo.

Known local-pack hazard: paths containing spaces are rejected up front by the
harness. Keep both the Vendo workspace path and `corpus/.repos/<name>/` paths
space-free.

## Manifest

`corpus/manifest.json` is a JSON array. Each entry has:

- `name`: stable lowercase repo identifier.
- `gitUrl`: HTTPS git URL.
- `pinnedSha`: 40-character commit SHA from the repo's default branch.
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
sweep on a schedule (08:00 UTC daily) and on demand via `workflow_dispatch`
(inputs: `repos` space-separated filter, `layer` 1/2/3). It builds the
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
