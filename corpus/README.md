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
- `pnpm corpus ai [repo...] [--model <id>]... [--json] [--strict]` runs the AI
  extraction matrix (see below).
- `pnpm --filter @vendoai/corpus-harness test` runs the harness unit tests.

Run artifacts are written under `corpus/.repos/.logs/`, with a copy of the
aggregate scorecard under each selected repo's `run/` directory. The runner
invokes the built umbrella CLI as `vendo init <repo> --yes`, after local package
injection. Pass `--json` to print the machine-readable scorecard, and
`--strict` to make hard failures return a nonzero exit code. Without `--strict`,
the sweep reports all repo failures and exits 0.

The sweep always consents to init's AI extraction pass (`--ai-polish`). That
pass needs `ANTHROPIC_API_KEY` in the environment plus a `claude` binary on
`PATH` (the harness does not ship the Agent SDK); without either, init
degrades gracefully — the AI pass self-skips, init exits green, and the
deterministic structural checks still run. The layer split leans on exactly
that: layer 1 is the structural clean room (zero model credentials), and the
full AI sweep (layer 2 scoring + AI polish) runs on the Mac mini.

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
§2 survives corpus layers 1 and 2.

## Manifest

`corpus/manifest.json` is a JSON array. Each entry has:

- `name`: stable lowercase repo identifier.
- Source: either `gitUrl` plus a 40-character `pinnedSha`, or a repo-relative
  `localPath`; the two forms are mutually exclusive.
- `framework`: optional `next` or `express` structural wiring mode; defaults to
  `next`.
- `packageManager`: optional `pnpm@x.y.z`-style pin written into the checkout's
  root `package.json` when the repo declares none of its own — without it
  corepack resolves the Vendo root's pin, a different major.
- `license`: SPDX identifier or a documented best-effort license string.
- `tier`: `broad` or `deep`.
- `bootstrap`: install command, env template, optional typecheck command, and
  build command.
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

## Running the sweep

Run `pnpm build` first: the harness imports `@vendoai/core` at load, so a cold
checkout fails before the first repo is cloned. Then, on demand — the sweep
never runs in CI. Layer 1 is free — the structural clean room, no model
credentials — so run
`pnpm corpus run --layer 1 --json --strict` before any PR that touches init
(`--strict` makes a hard structural failure exit nonzero);
`corpus/scripts/corpus-trend.mjs` appends a trend delta versus the previous
scorecard. The costed half — layer 2 scoring, the init AI polish pass, and
`pnpm corpus ai` — runs on the Mac mini before releases.

## Judgment channel matrix

`pnpm corpus ai` measures the judgment channel (the pass that grades tool
descriptions, risk, critical marks, and wakes with quoted evidence and an
independent skeptic) per repo and per model. For each selected repo it runs the
normal checkout, bootstrap, local-package injection, and `vendo init` (producing
the static `.vendo/tools.json`), then for each model runs the real
`runJudgmentPass` — reading the actual repo, writing into a clean per-model
scratch `.vendo` — and scores the `judgments.json` it wrote against
`corpus/expectations/<repo>/ai-expected.json` (format documented in
`corpus/expectations/README.md`).

Two things about a cell are worth knowing:

- it runs `mode: "full"`, `loosenings: "review"` with an auto-approving
  `confirm`. A loosening (a risk downgrade, a woken tool) is precisely what the
  channel will not apply on its own, and an unattended review DECLINES by
  default — so without the auto-yes the matrix would only ever measure
  hardenings.
- it is scored from the judgments file read back off disk, not from the pass's
  return value, because that file is the channel's actual output — the artifact a
  human reviews, `vendo doctor` displays, and the runtime resolves
  through `effectiveHostTool` (`packages/actions/src/runtime/registry.ts`,
  `mergeOverride(applyJudgment(extracted, judgment), override)`). The rubric
  computes that same state with the same `applyJudgment`, so it grades what the
  channel decided rather than a re-implementation.

Scored dimensions: risk accuracy against the labels (both directions —
hardenings and downgrades), critical marks, wake decisions, evidence present on
every applied judgment, and description-quality proxies.

Two of those columns cannot score against today's labels: no `ai-expected.json`
in the corpus populates `critical` or `wake`, and no `disabled` tool carries a
joined label, so `Critical` and `Wake` render `—` everywhere. Fix the labels
before reading those columns as a verdict.

- Repos default to every one with an `ai-expected.json`; pass names to filter.
- Models: repeat `--model <id>` (or comma-separate) to build the matrix; each
  run sets `VENDO_MODEL_EXTRACT` for the harness. With no `--model` flag a
  single `default` column exercises the harness default (which itself honors a
  `VENDO_MODEL_EXTRACT` already present in the environment).
- Credential: the run needs `ANTHROPIC_API_KEY` or a Claude Code login and
  fails fast with a clear message when neither is available. The Claude Agent
  SDK deliberately exists nowhere in the workspace (host-only resolution
  doctrine); the matrix
  provisions a pinned copy into the gitignored `corpus/.repos/.agent-sdk/`
  cache on first run (needs npm + network once).
- CI posture: like the other live layers, the AI matrix is never part of
  `pnpm test` — unit tests cover the scoring rubric with canned drafts, and
  the matrix itself runs on demand only.

Reading the scoreboard: the run writes `corpus/.repos/.logs/ai-scoreboard.md`
(and `.json`, also printed with `--json`) with one row per repo × model. The
Score column is the weighted rubric value (0–1); the Draft, Guards,
Descriptions, Risk, Wake, and Brief columns show per-dimension sub-scores, and
Notes lists failing check ids (details live in each run's `checks.json`). A row
whose draft never parsed (or whose harness errored) is floored at 0 with the
same check set, so model columns stay comparable. Guard "false refusals" —
model downgrades the guards blocked but the labels agree with — are surfaced
in check details as a pipeline signal without failing the run. Staged-pipeline
degradations (skipped surfaces, failed cross-check) surface as notes, not
failures. Per-cell artifacts (per-stage outputs under `stages/`, degradation
notes, resulting overrides.json/brief.md, checks) land under
`corpus/.repos/.logs/<repo>/ai/<model>/`. Without `--strict` the sweep reports
failures and exits 0; `--strict` returns nonzero when any run failed.

## Required environment

- `CORPUS_<REPO>_<KEY>` — per-repo bootstrap secrets referenced as
  `${CORPUS_<REPO>_<KEY>}` placeholders in a manifest `envTemplate`.
- No model credentials for layer 1: it is the structural clean room and needs
  no `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`. LLM-costed runs (layer 2 and
  `corpus ai`) happen on the Mac mini or locally.

Run a filtered sweep with `pnpm corpus run umami taxonomy --layer 1`.
