# Vendo

Vendo is a devtool that lets a company's users customize its product: an
embedded agent that acts through the host's own API as the user and renders
generated UI in a sandboxed, brand-native surface.

## Layout

- `packages/` — the ten `@vendoai/*` blocks + the `@vendoai/vendo` umbrella and
  `vendoai` alias. The behavior contract is the exported types/zod schemas and
  the test suites — there are no prose contract docs; layering enforced by
  `scripts/dependency-guard.mjs` in `pnpm lint`
- `examples/` — the demo host `demo-bank` (Maple) and the framework integration
  examples (`ai-sdk-agent`, `mastra-agent`, `claude-code-plugin`)
- `corpus/` — init-extraction corpus harness (`pnpm corpus`)
- `docs-site/` — the public docs site

## Commands

- `pnpm install` · `pnpm typecheck` · `pnpm lint` (turbo-cached) — the local loop
- `pnpm build` · `pnpm test` · `pnpm test:affected` (changed packages only) — on demand, not required before a PR
- Demo: `pnpm --filter demo-bank dev` (Maple)

## Vendo Cloud

- Cloud sells exactly two categories: infrastructure that is painful to run
  yourself (sandbox, inference, persistence, brokers, hosted automations) and
  inherently multi-party coordination (sharing, registry, orgs, SSO, billing,
  console). Everything else stays OSS.
- Hard BYO rule: every single-player capability keeps a no-key
  bring-your-own path (own Postgres, sandbox account, model key, OAuth apps).
- Adapter rule: one adapter interface per block; Cloud is just another
  implementation shipped in OSS. `VENDO_API_KEY` sets Cloud defaults only for
  adapter slots the host left unset; an explicitly passed adapter always
  wins; no hidden key-conditional branches. Reference implementation:
  `selectConnections` in `packages/vendo/src/compose-selection.ts`.
- Gating is valid key + meter, nothing else: no capability booleans, no
  entitlement protocol, no validate endpoint, no client-side checks. Key
  problems surface on the first real service call.
- Managed inference rides the console's Anthropic-compatible model gateway
  through the stock `@ai-sdk/anthropic` provider, so inference traffic does
  not carry the deployment-identity headers and does not feed the deployment
  inventory (known, accepted).

## Rules

- Answer code-behavior questions from source only — read the definition and
  its callers, cite `file:line`. Docs and comments are leads, never answers.
- Use Yousef's Vendo Cloud account for any and all testing.
- Vendo-facing API/SDK/CLI design additionally routes through the
  **vendo-dx** skill (on top of api-design-dx).
- Never commit to `main`; branch and open a PR.
- Local gate = `pnpm typecheck && pnpm lint`, plus the test FILES covering what
  you touched, run directly (`pnpm --filter <pkg> exec vitest run <files>
  --minWorkers=1 --maxWorkers=2` — always set both). Nothing else is required
  before a PR. The PR's green `ci` check is the gate of record; running whole
  package suites locally only duplicates it minutes early.
- The browser suite is an on-demand tool, not a gate: reach for it when you
  need to SEE a UI change or diagnose one, not because a PR touches UI.
- `vendo-web` is archived. The Cloud half now lives in the private monorepo
  and consumes these packages as `workspace:*`, so it moves in lockstep with
  every release automatically — no downstream bump step.
- Versions are computed in the private monorepo's CI, never in the public repo.
  Every push to private `main` refreshes one standing `chore: version packages`
  PR from `changeset-release/main`, which runs `changeset version` and arms its
  own auto-merge; merging it is the release. The bump then reaches the public
  repo as an ordinary sync, and the public repo tags `v<version>` and publishes
  on version change — it opens no version PR of its own. Feature PRs still carry
  a changeset (`pnpm changeset`). Coming back the other way, an hourly job opens
  an import PR whenever public main holds a commit this repo did not write;
  docs-only imports (the Mintlify bot's) merge themselves, everything else waits
  for a human.
  Privately, that version PR is fast-laned through every required check — it is
  a `packages/**` diff and would otherwise drag the whole estate through a full
  run — and `changeset-release/main` is the branch name each workflow keys on.

## Tests

- A harness that mocks the counterparty proves nothing. When a feature spans
  a producer and a consumer, test the SEAM: write through the real write path
  and read back through the real read path, with no stub on either side. The
  host-component previews shipped four times with a green suite and a dead
  feature because the producer and the consumer each mocked the other, so
  they could never disagree. Anything this repo emits for the console to read
  (`.vendo/components/`, `vendo_*` collections, blob namespaces) is one of
  those seams, and the console's copy of the schema is a mirror — see the
  testing section of the console's own `AGENTS.md` for the full lesson.
- Two suites must not share a directory that either of them deletes.
  `next build` wipes its whole `distDir`, so a fixture dev server's dist dir
  is a SIBLING of the build's, never a child. Nesting them took out all 36
  `automations-e2e` tests on every full-suite run while each suite passed
  alone, and which suite lost varied by scheduling — which read as flake.
- A poll inside a test must not have a wall-clock budget tighter than the
  test's own timeout. The test timeout is the hang-detector; a tighter inner
  budget is a second, invisible speed limit that reports a product bug when
  the machine is merely busy.
- The full suite is CI's job now (`.github/workflows/ci.yml`), fanned out over
  a shared turbo remote cache: `typecheck-lint` (build + typecheck + lint),
  `test-shards` (9 intra-package vitest shards for the big three — vendo×4,
  store×3, ui×2), `test-rest` (the other packages in 2 turbo groups: guard +
  actions, then everything else expressed as negations so a new package joins
  the day it is created), and `coverage-merge`, which replays the shards' blob
  reports and enforces the per-package coverage floors — a floor is only
  meaningful against the whole suite, so the per-shard runs set `VITEST_SHARD`,
  which drops the thresholds in each package's vitest config, and the gate moves
  to the merge. It is an env var and not a CLI override because an override
  reaches one key at a time and silently stops covering a floor added later. The
  aggregate job is named `ci`; the required checks on main are `ci`,
  `integration`, `conformance`, and `audit`, and renaming any of those job
  names breaks merges. No browser runs in CI (2026-08-06) — headless
  mis-resolves `:focus-visible` and `light-dark()`, so the Playwright suites run
  locally, on demand, and gate nothing.
- WHEN you do run a browser spec, it is two-speed. While you are editing, start
  ONE warm hot-reloading harness (`VENDO_HARNESS_DEV=1` plus a pinned
  `VENDO_HARNESS_PORT`) and rerun specs against it with the same two variables —
  reuse is dev-mode-only, so every rerun skips the build and starts in seconds.
  If you are going to report a result, take it from one run WITHOUT the flag: a
  production run never reuses a server, because `vite preview` serves whatever
  was built last, so a reused one greens the previous build.
- An agent proves a browser flow by SCRIPTING it, never by stepping through it
  click-by-click: write one throwaway Playwright script for the whole flow, run
  it once, judge the screenshot/video artifacts — one model turn instead of
  fifteen, seconds instead of minutes. Interactive stepping is for two cases
  only: exploring UI the agent didn't write, and diagnosing a scripted run that
  failed for unclear reasons — and whatever stepping teaches gets banked as a
  script so the flow is never stepped twice.
- `--continue` and a turbo concurrency bound are the standing rule wherever the
  suite runs: `--continue` so one red package never hides every other package's
  result; the bound (2 in CI's `test-rest`, 4 in the root `test` /
  `test:affected` / `test:coverage` scripts) because unbounded parallelism runs
  ~27 vitest workers at once on a 12-core laptop (load average ~150) and the
  full-stack suites in `packages/vendo` then miss their 30s budget on work that
  takes 5s alone. A timeout is a hang-detector; do not raise one to buy headroom
  the machine never had. Locally you should be running test FILES, not package
  suites, so this rarely binds; when you do reach for `pnpm test:affected`, it
  carries the same caps. Never run the full suite on a laptop.
- Turbo's bound is only the OUTER layer. Each package's vitest sizes its own
  worker pool to the CPU count, so 4 packages at a time meant ~60 processes and
  ~13GB on a 12-core laptop, and an OOM kill on a 15GB runner — the PGlite
  suites (`store`, `guard`, the fixtures) boot an embedded Postgres per worker.
  `VITEST_MIN_FORKS/MAX_FORKS` and `VITEST_MIN_THREADS/MAX_THREADS` cap the
  inner layer at 2 workers — set in the root `test` / `test:affected` /
  `test:coverage` scripts locally, and at job level on `test-shards`,
  `test-rest` and `coverage-merge` in CI (which invoke vitest and turbo
  directly, so they do not inherit the root scripts). Set them in any new script
  or workflow that runs the suite — an uncapped job sizes its pool to the core
  count, and workers EQUAL to the core count is its own failure: it leaves
  nothing for the main thread the workers report to, and vitest fails with
  `[vitest-worker]: Timeout calling "onTaskUpdate"`, every test passing, exit 1.
  Measured, not assumed: the public runner is 4 cores / 16 GB and its shards drew
  a mean 88% of it at 4 workers; the private runner is 2 cores / 7.9 GB and went
  red at 2 workers, green at 1. The MIN half is not optional:
  vitest 2.1 defaults `minThreads` to the CPU count independently of the max, so
  a max-only cap makes Tinypool throw `minThreads and maxThreads must not
  conflict` before a single test runs. `fileParallelism: false` still wins where
  a package sets it, so the serial suites stay serial.
