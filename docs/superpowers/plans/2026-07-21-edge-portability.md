# Edge Portability Campaign

> Origin: Mohamed Habib (digger.dev) deployed Vendo on Cloudflare Workers and hit nine
> issues (email 2026-07-21, branch diggerhq/opencomputer#feat/vendo-cloudflare-edge).
> Root-cause analysis reduced them to three broken assumptions. This plan removes the
> assumptions, not just the symptoms, so any Web-standard runtime (Workers, Bun, Deno,
> Vercel/Netlify Edge) works without golden-path treatment.

**Goal:** `@vendoai/vendo/server` provably runs on Web-standard JavaScript runtimes,
init/doctor stop assuming Next or Express, and the core promise (agent acts through
the host API) can never degrade silently.

**Coordination:** two wave2 agents are mid-flight in sibling worktrees
(`wave2-runtime-fixes`: apps engine + mastra; `wave2-init-doctor`: init install funnel
+ framework detection). PR 1 has no file overlap and ships first. PRs 3-5 rebase after
wave2 lands. npm release goes through the npm-2 session after merges.

**Decisions locked during root-cause analysis:**
- Portability mechanism = package export **conditions** (`worker`, `workerd`,
  `edge-light`, `browser` map Node-only legs to fail-with-guidance stubs; `default`
  keeps today's Node behavior). One mechanism every bundler and Node itself respects;
  no bundler-specific magic comments (that was the e2b failure mode).
- The e2b optional SDK import becomes non-analyzable (variable specifier) so no
  bundler resolves it at build time; a missing SDK errors at use with guidance.
- `createVendo()` becomes construction-pure: schema readiness, the session sweep
  timer, and telemetry init defer to first handler touch. Lazy is correct on Node too.
- The gate, not review, enforces all of this forever: bundle the server entry for
  a worker target with zero unresolved imports, then boot it under workerd and serve
  requests at module scope.

---

## PR 1 — Workers runtime portability + CI gate (this worktree)

### Task 1: bound-fetch helper
- Add a `boundFetch`-style default helper in `packages/core` (test: calling the
  stored default with a mock strict-`this` fetch must not throw).
- Replace `options.fetch ?? globalThis.fetch` at all seven sites:
  `core/src/heartbeat.ts:38`, `vendo/src/hosted-store.ts:133`,
  `vendo/src/cloud-apps.ts:47`, `vendo/src/sandbox.ts:195`,
  `vendo/src/connections.ts:165`, `vendo/src/refine.ts:639`,
  `vendo/src/cloud-console.ts` call-through.
- Guard against regression: lint-style unit test greps source for the raw pattern.

### Task 2: e2b import made bundler-safe
- `packages/apps/src/e2b/index.ts`: route the three `import("e2b")` sites through a
  non-analyzable specifier; keep the ignore comments for webpack/turbopack warnings.
- Test: esbuild-bundle a probe entry importing `@vendoai/apps/e2b` with e2b absent —
  must succeed; invoking create without the SDK must throw the guidance error.

### Task 3: telemetry off the edge path
- `packages/vendo-telemetry`: config/base-props (node:crypto, fs, os, homedir) move
  behind an internal conditional import; worker/edge condition gets a no-op telemetry
  (init returns disabled client). `globalThis.crypto.randomUUID` replaces node:crypto
  everywhere it survives.
- Test: bundle probe with worker condition contains no `node:` specifiers.

### Task 4: dev-creds ladder contained
- `packages/vendo/src/dev-creds/model.ts` (and its `cli/cloud/client` import chain):
  Node-only resolution (createRequire, file URLs, ~/.vendo session reads) moves behind
  an internal conditional subpath; worker/edge condition yields a resolver that
  reports "no dev credential ladder on this runtime" through the existing unavailable
  path, so explicit model / VENDO_API_KEY setups never touch it.
- Managed-inference fix inside the same seam: when the cloud key path is taken, build
  the gateway provider statically (no require.resolve), matching what Mohamed
  hand-wired.

### Task 5: local store leg contained
- `packages/store`: the pg/PGlite local engine goes behind an internal conditional
  subpath; worker/edge condition throws with guidance ("pass store: or set
  VENDO_API_KEY"). Hosted store stays portable.

### Task 6: actions sync split out of the runtime entry
- `packages/actions`: `vendoSync` + static extractors (TypeScript compiler, node:fs)
  move from the main entry to an `@vendoai/actions/sync` subpath. Update all
  importers (CLI, corpus, tests). Runtime registry keeps zero sync imports; verify
  `runtime/registry.js`'s node imports and contain them the same way.

### Task 7: construction-pure createVendo
- `packages/vendo/src/server.ts`: `ensureSchema()` kick-off, sweep `setInterval`,
  and `initTelemetry` defer to a once-guarded first-request hook on the handler
  path. `close()` still tears the timer down; Node behavior unchanged (existing
  tests prove it).
- Test: constructing at simulated module scope performs no I/O and starts no timer
  (spies); first handler call performs both exactly once.

### Task 8: the portability gate
- `scripts/portability-gate.mjs`: (a) esbuild-bundles `packages/vendo/dist/server.js`
  with a worker condition set, fails on ANY unresolved import; (b) boots the bundle
  under workerd (miniflare devDep) from a fixture worker that calls createVendo at
  module scope and serves `/status`, asserts 200 and a streamed turn survives.
- Fixture lives in `scripts/fixtures/portability-worker/`.
- Wire into root `pnpm lint` (alongside dependency-guard) and the PR workflow.

### Task 9: gates + PR
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green; PR with the
  gate output and the fixture boot log; the email symptoms mapped to fixes in the
  PR body.

## PR 2 — universal wiring + Workers docs (after PR 1)
- Runtime-neutral lazy-singleton wiring template (env-in, Request→Response out) as
  the init fallback for unrecognized frameworks; Mohamed's hand-rolled file is the
  reference shape. Coordinate with wave2-init-doctor's init changes; rebase on it.
- docs + docs-site: "Vendo on Cloudflare Workers" page: wrangler config, conditions,
  VENDO_BASE_URL, what the free plan covers.

## PR 3 — behavior-based doctor (after wave2-init-doctor lands)
- Unknown-framework detection outcome: generic wiring checks (createVendo imported,
  handler mounted, VendoRoot rendered anywhere) as warnings, not E-WIRE-003/004
  failures; live probes stay the source of truth.
- New checks: empty applied tool surface = failure; VENDO_BASE_URL guidance in the
  present-credentials probe failure.

## PR 4 — extraction audience classification
- `cli/extract`: classify candidate endpoints end-user vs internal/operator (auth
  scope heuristics + extraction-model judgment); internal excluded by default,
  surfaced in the brief as an explicit "excluded internal surface" section.
- Empty-surface warnings at init apply time and server boot.

## PR 5 — structured stream errors
- Wire + UI: a stream that dies carries a structured terminal error event; the thread
  renders cause + retry guidance instead of the bare "Something went wrong" banner
  (`ui/chrome/thread/index.tsx:218`). Rebase after wave2-runtime-fixes (ui overlap).
- Use the workerd fixture from PR 1 to reproduce the apps-create mid-stream death and
  pin the actual killer; fix what it reveals.

## Ship
- npm release via the npm-2 session once merged; then send Mohamed the follow-up
  (draft already sitting in the Gmail thread) and diff his branch's workarounds
  against the fixes.
