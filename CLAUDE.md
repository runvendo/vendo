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
- `docs/` — integration docs; `docs-site/` — the public docs site

## Commands

- `pnpm install` · `pnpm build` · `pnpm test` · `pnpm test:affected` (scoped to changed packages — the local default) · `pnpm typecheck` · `pnpm lint` (turbo-cached)
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
- UI-affecting changes are verified in a real browser with screenshots in the
  PR. Tests and typecheck alone don't count.
- Local gate = `pnpm build && pnpm test:affected && pnpm typecheck && pnpm lint`
  on the touched scope. The FULL suite runs only in CI — the PR's green `ci`
  check is the gate of record; never run the full suite locally.

## Tests

- A harness that mocks the counterparty proves nothing. When a feature spans
  a producer and a consumer, test the SEAM: write through the real write path
  and read back through the real read path, with no stub on either side. The
  host-component previews shipped four times with a green suite and a dead
  feature because the producer and the consumer each mocked the other, so
  they could never disagree. Anything this repo emits for `vendo-web` to read
  (`.vendo/components/`, `vendo_*` collections, blob namespaces) is one of
  those seams, and the console's copy of the schema is a mirror — see the
  testing section of `vendo-web/AGENTS.md` for the full lesson.
- Two suites must not share a directory that either of them deletes.
  `next build` wipes its whole `distDir`, so a fixture dev server's dist dir
  is a SIBLING of the build's, never a child. Nesting them took out all 36
  `automations-e2e` tests on every full-suite run while each suite passed
  alone, and which suite lost varied by scheduling — which read as flake.
- A poll inside a test must not have a wall-clock budget tighter than the
  test's own timeout. The test timeout is the hang-detector; a tighter inner
  budget is a second, invisible speed limit that reports a product bug when
  the machine is merely busy.
- The full suite (`pnpm test`) is CI's job now — sharded into 8 vitest shards
  for the big three (vendo×3, store×3, ui×2), 2 turbo groups for the remaining
  packages, and a `hermetic-extras` job for the orphan suites. It still runs
  with `--continue` and `--concurrency=4`, the same bound CI has used since
  #340: `--continue` so one red package never hides every other package's
  result; the bound because unbounded parallelism runs ~27 vitest workers at
  once on a 12-core laptop (load average ~150) and the full-stack suites in
  `packages/vendo` then miss their 30s budget on work that takes 5s alone. A
  timeout is a hang-detector; do not raise one to buy headroom the machine
  never had. Locally, run `pnpm test:affected` instead — same caps, scoped to
  changed packages; never run the full suite on a laptop.
- Turbo's bound is only the OUTER layer. Each package's vitest sizes its own
  worker pool to the CPU count, so 4 packages at a time meant ~60 processes and
  ~13GB on a 12-core laptop, and an OOM kill on a 15GB runner — the PGlite
  suites (`store`, `guard`, the fixtures) boot an embedded Postgres per worker.
  `VITEST_MIN_FORKS/MAX_FORKS` and `VITEST_MIN_THREADS/MAX_THREADS` in the root
  `test` and `test:coverage` scripts cap the inner layer at 4 x 2 workers, which
  is why CI runs those scripts instead of calling turbo itself. Set them in any
  new script or workflow that runs the suite. The MIN half is not optional:
  vitest 2.1 defaults `minThreads` to the CPU count independently of the max, so
  a max-only cap makes Tinypool throw `minThreads and maxThreads must not
  conflict` before a single test runs. `fileParallelism: false` still wins where
  a package sets it, so the serial suites stay serial.
