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
- `pnpm corpus gallery [repo...]` boots selected deep-tier repos and captures
  host-native baselines, generated UI screenshots/GIFs, and latency timings.
  With no repo arguments it discovers repos that have
  `corpus/expectations/<repo>/gallery.json`; there is no hardcoded gate set.
- `pnpm corpus ai [repo...] [--model <id>]... [--json] [--strict]` runs the AI
  extraction matrix (see below).
- `pnpm corpus install-eval [fixture...] [--model <id>] [--dry-run] [--json]
  [--strict] [--turn-budget <n>] [--time-budget-ms <ms>] [--max-budget-usd <usd>]`
  runs the agent-install eval (see below).
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

## AI extraction matrix

`pnpm corpus ai` measures the AI extraction pass (the `vendo init` agent that
drafts tool descriptions, risk grades, wakes, and the product brief) per repo
and per model. For each selected repo it runs the normal checkout, bootstrap,
local-package injection, and `vendo init` (producing the static
`.vendo/tools.json`), then for each model runs the real extraction flow — the
staged pipeline (survey → draft-per-surface → cross-check → brief) through the
Claude Agent SDK harness, then the deterministic applyDraft guards into a
clean per-model scratch root — and scores the result against
`corpus/expectations/<repo>/ai-expected.json` (format documented in
`corpus/expectations/README.md`).

- Repos default to every one with an `ai-expected.json`; pass names to filter.
- Models: repeat `--model <id>` (or comma-separate) to build the matrix; each
  run sets `VENDO_EXTRACTION_MODEL` for the harness. With no `--model` flag a
  single `default` column exercises the harness default (which itself honors a
  `VENDO_EXTRACTION_MODEL` already present in the environment).
- Credential: the run needs `ANTHROPIC_API_KEY` or a Claude Code login and
  fails fast with a clear message when neither is available. The Claude Agent
  SDK deliberately exists nowhere in the workspace (host-only resolution
  doctrine, enforced by the dev-riders missing-install test); the matrix
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

## Agent-install eval

`pnpm corpus install-eval` proves a real coding agent can install Vendo from
the docs' copy-paste prompt alone (agent-install DX design 2026-07-19
§Testing). Per fixture it:

1. Copies the fixture source (`invoify` — external pinned corpus repo,
   cloned through the normal manifest-pin machinery — plus `express-host`,
   `apps/demo-bank`, `apps/demo-accounting`) to a clean directory under
   `corpus/.repos/.install-eval/` with the Vendo footprint stripped: no
   `.vendo/`, no vendoai/@vendoai dependency or override, no lockfile, no
   CLAUDE.md/AGENTS.md/.claude (a clean host repo carries none of that), then
   snapshots it as a one-commit git repo so agent edits stay diffable.
   **Known limit (read demo rows accordingly): the demo apps' source still
   imports Vendo** — de-integrating their app code would be a
   hand-maintained fork — so those rows measure "restore an install whose
   deps and contract are gone". `invoify` is a truly pre-Vendo host and
   `express-host` is the closest local one. Of the other external corpus
   repos, the deep-tier ones (umami, skateshop, papermark, teable, twenty)
   need dockerized Postgres/Redis + seeds for their dev servers and the
   remaining broad-tier ones need real third-party env (Clerk, GitHub
   OAuth, Shopify, ClickHouse) or have no dev-server recipe, so they stay
   out until fixture prep grows the corpus bootstrap/database machinery
   (documented in `harness/src/install-eval/fixtures.ts`).
2. Serves a minimal local npm registry: Vendo packages resolve from
   `pnpm pack`ed workspace tarballs (cached in
   `corpus/.repos/.install-eval-tarballs/`), every other request 302s to
   registry.npmjs.org. The fixture's `.npmrc` points `registry=` at it, so
   the agent's own `npm install vendoai` lands on the local build. (The
   injector's overrides trick cannot work here: npm rejects a direct install
   of an overridden package with EOVERRIDE.)
3. Runs headless Claude Code (`claude -p <prompt> --output-format
   stream-json`) cwd'd into the fixture with ONLY the copy-paste prompt,
   read from `docs-site/install.mdx` at runtime so drift is impossible.
   Budgets: `--max-budget-usd` (CLI-enforced, default 10) and a wall-clock
   kill (default 20 min); the turn budget (default 40) is a scoring
   threshold — the 2.1.x CLI has no turn-cap flag. `--setting-sources
   project` keeps the machine's user-level CLAUDE.md/skills out of the
   measurement, and `VENDO_API_KEY` is dropped from the agent's environment
   so a machine key cannot short-circuit the account-consent metric. The
   full stream-json transcript lands in
   `corpus/.repos/.logs/<fixture>/install-eval.transcript.jsonl`.
4. Scores machine-derived metrics: `doctor_green` (the harness boots the
   fixture dev server and runs the fixture's own `node_modules/.bin/vendo
   doctor . --json` itself — the agent's claim is never trusted), turn
   count/cost/duration from the transcript, `asked_before_account`
   (no cloud-login/key-mint/signup tool call without a preceding
   account-topic question or AskUserQuestion), and playbook violations:
   hand-wrote regenerated scaffold files (`.vendo/tools.json`, `theme.json`,
   `catalog.json`, or creating the route/registry/.vendo before any
   `vendo init`), invented tools (overrides/policy naming tools absent from
   `tools.json`), skipped star ask. These transcript checks are documented
   regex heuristics — triage signals to read against the transcript, not
   ground truth; doctor-green and turns are exact.
5. Writes the matrix report to `corpus/reports/install-eval-<runId>.md` and
   `.json` — commit the report of a live run as evidence in the PR that
   acts on it. The footer restates the spec rule: new failure modes get a
   doctor error code plus a verify-page section before they may be called
   fixed.

Cost and CI posture: a live run spends real model money — budget-capped at
`--max-budget-usd` (default 10 USD) per fixture, so a full three-fixture
matrix is ≤ 30 USD worst-case and typically an order less on sonnet
(observed corpus installs land in low single-digit dollars per fixture; a
haiku smoke is cents). The eval is therefore never part of `pnpm test`,
turbo pipelines, or any workflow — on-demand only, exactly like `corpus ai`
and `gallery`. `--dry-run` exercises the entire pipeline (fixture prep,
tarball pack, local registry, scoring, report) against the canned transcript
in `corpus/harness/test/fixtures/install-eval/` without invoking the agent
or doctor, and the unit tests cover every scoring heuristic with canned
events.

## Generation gallery

Each deep-tier gallery config contains one or two `nativeScreens` (`id`,
`label`, host-relative `path`, and optional `waitFor` selector) plus a set of
UI-generating `prompts` (`id`, `label`, `prompt`, and optional `timeoutMs`). The
gallery command reuses the normal checkout, bootstrap, local-package injection,
`vendo init`, per-repo e2e preparation, and boot recipes before opening the
Layer-3 Playwright surface. The manifest `buildCommand` runs first only when
the recipe's `devServer.requiresBuild` is true (express-host, whose start
script serves prebuilt `dist/` output); self-compiling dev servers boot
directly, exactly like `pnpm corpus boot`.

Artifacts are written under
`corpus/.repos/.gallery/<runId>/<repo>/`. Every prompt gets
`first-paint.png`, `settled.png`, `timings.json`, and `generation.gif`. Timing
marks are measured automatically at prompt submission, the generation tool
call, the first visible generated pixel, and the settled/usable view. The
harness approves generation create/edit cards when required so the end-to-end
numbers include any approval wait. The report labels both end-to-end
prompt-submit latency and generation-tool-call latency distinctly, and calls
out nearest-rank p95 generation bars of first paint under 1 second and usable
under 10 seconds across successful captures. If
`ffmpeg` is unavailable or conversion fails, the Playwright `generation.webm`
is retained and the fallback is recorded in `timings.json` and the report.

The run root contains one `gallery.html` with all screenshots and animation
bytes inlined as data URLs. It is standalone and can be opened directly for
side-by-side fidelity review. Gallery runs require Playwright Chromium and the
same Docker/secrets needed by the selected deep-tier boot recipes; source local
keys into the shell without copying them into any corpus config or artifact.

PR CI is untouched — no LLM cost or flakiness is added to the merge path.

Required secrets (Settings → Secrets and variables → Actions):

- `ANTHROPIC_API_KEY` (required) — real `vendo init` extraction needs an LLM
  key. The workflow fails fast if it is missing.
- `OPENAI_API_KEY` (optional) — alternate provider.
- `CORPUS_<REPO>_<KEY>` — per-repo bootstrap secrets referenced as
  `${CORPUS_<REPO>_<KEY>}` placeholders in a manifest `envTemplate`.

Run a filtered sweep on demand from the Actions tab → Corpus Nightly → Run
workflow, e.g. `repos: umami taxonomy`, `layer: 1`.
