# @vendoai/vendo

## 0.4.5

### Patch Changes

- 87eadba: fix(venue): e2b is only selectable when actually usable — 0.4.4 regression

  `e2bInstalled()` treated a runtime without `import.meta.resolve` as "the
  bundler inlined the SDK, so it must be available". Inside Turbopack/webpack
  server bundles that fallback always fired, so a stray `E2B_API_KEY` (for
  example inherited from the shell) flipped the venue ladder to an e2b the
  runtime could never load, outranking the Vendo Cloud sandbox and killing
  every server-app build — 0.4.3 printed `execution venue: cloud`, 0.4.4
  printed `e2b` on the same host. The probe now tests usability instead of
  importability: it asks Node's own resolver (`require.resolve` via
  `process.getBuiltinModule`, which works inside server bundles), falls back to
  a real `import.meta.resolve`, and reads an unverifiable runtime as NOT
  installed — the SDK is never bundler-inlined (the mutable-specifier import
  from the edge-portability work guarantees it), so the runtime resolver is the
  only truth. With `VENDO_API_KEY` set and no usable e2b, the venue is the
  Cloud sandbox again.

  `vendo doctor` also stops false-blessing the venue: `execution venue: e2b`
  now passes only when `E2B_API_KEY` is set and the `e2b` package resolves from
  the project; otherwise it fails with E-LIVE-007 and a concrete fix line.

- Updated dependencies [31f899e]
- Updated dependencies [87eadba]
  - @vendoai/core@0.4.5
  - @vendoai/agent@0.4.5
  - @vendoai/apps@0.4.5
  - @vendoai/ui@0.4.5
  - @vendoai/actions@0.4.5
  - @vendoai/automations@0.4.5
  - @vendoai/guard@0.4.5
  - @vendoai/mcp@0.4.5
  - @vendoai/store@0.4.5

## 0.4.4

### Patch Changes

- 52c72c2: Doctor judges unknown-framework hosts (Cloudflare Workers, Bun, Hono, ...)
  by their actual wiring instead of Next.js file layout — no more permanent
  E-WIRE-003/004 false positives on custom runtimes (new codes E-WIRE-007/008).
  The tool surface is now graded statically: all extracted tools disabled or
  excluded fails doctor (E-TOOLS-001), an empty surface warns (E-TOOLS-002),
  and the actions registry warns at runtime when the agent composes with zero
  live host tools — the silently-useless-agent failure mode is no longer
  silent anywhere.
- 835d17a: Edge-runtime portability: the server entry now bundles and boots on
  Web-standard runtimes (Cloudflare Workers first). Fetch defaults are
  invocation-safe, the optional e2b SDK no longer breaks esbuild/Wrangler
  builds, Node-only legs (local store engines, dev model ladder, telemetry
  disk config, actions sync tooling) sit behind worker/edge export
  conditions with honest guidance, and createVendo performs no I/O, timers,
  or random generation at construction — module-scope wiring works. A CI
  portability gate (bundle + real workerd boot) keeps it that way.

  Note for hosts that reach into composed blocks directly: the BYO tool seam
  (`vendo.guardedTools`, and the ai-sdk/mastra packs built on it) arms schema
  readiness on first execute. Raw `vendo.store`/`vendo.automations` reach-ins
  should `await vendo.store.ensureSchema()` first — the previous eager kick
  only ever gave that pattern a racy head start.

- 70b59db: Extraction now grades every tool's audience (end-user / operator / internal)
  by reading the handler's own auth checks, and excludes non-end-user tools
  from the embedded agent by default (recorded as `audience` in
  .vendo/overrides.json; human decisions always win). Applying a surface that
  leaves the agent with zero live tools warns loudly instead of shipping a
  silently useless agent. Field origin: an infra product's extraction proposed
  operator/reconciliation endpoints; stripping them by hand left an empty
  toolkit and an agent that couldn't act.
- 0c1fca2: `vendo init --framework custom`: a runtime-neutral wiring for any
  Web-standard host (Cloudflare Workers, Bun, Deno, Hono). The generated
  vendo/server.ts is a lazy Request→Response module with the environment
  passed per call; with a Vendo Cloud key it wires the Cloud adapters
  explicitly (model = stock Anthropic provider at the console gateway).
  Unknown-framework detection lands here instead of guessing the Next
  layout into hosts that aren't Next.
- Updated dependencies [52c72c2]
- Updated dependencies [835d17a]
- Updated dependencies [70b59db]
- Updated dependencies [89e3d2b]
  - @vendoai/actions@0.4.4
  - @vendoai/core@0.4.4
  - @vendoai/apps@0.4.4
  - @vendoai/automations@0.4.4
  - @vendoai/store@0.4.4
  - @vendoai/telemetry@0.3.2
  - @vendoai/agent@0.4.4
  - @vendoai/ui@0.4.4
  - @vendoai/guard@0.4.4
  - @vendoai/mcp@0.4.4

## 0.4.3

### Patch Changes

- 7355eed: Install-funnel fixes from the 0.4.x E2E certification (Wave 2):

  - **Visible surface (B3).** `vendo init` now generates a `"use client"` mount
    wrapper (`vendo/vendo-root.tsx`) that applies the registry + theme and
    mounts `<VendoOverlay />`, and wires it into the Next.js layout with one
    bounded, idempotent edit (skipped when a Vendo mount already exists;
    degraded to printed paste lines when the layout has no single unambiguous
    `{children}`). The wrapper is the RSC-safe home for the registry import —
    the previously printed registry-in-server-layout paste crashed every page.
    `VendoOverlay` is re-exported from `@vendoai/vendo/react` so the scaffold
    resolves under pnpm strict linking.
  - **Principal alignment (B4).** The anonymous scaffold's wire principal now
    resolves the same demo subject the existing-agents quickstart chat routes
    set (`demo-user`) instead of `null`, so apps and approvals created through
    a BYO agent loop are visible to the embeds. `GET /apps/:id/open?pending=1`
    now distinguishes a record that exists under another principal (terminal
    `{kind:"failed"}` with the mismatch diagnosis) from a still-building app
    (`{kind:"pending"}`) — no more infinite skeleton.
  - **Doctor honesty.** New E-WIRE-006 check fails when no visible surface is
    mounted anywhere; new E-LIVE-006 render gate GETs the app root and fails on
    a 5xx; new E-DEP-002 fails when the running wire's `/status` version
    disagrees with the CLI's (split-brain installs where a direct
    `@vendoai/vendo` pin beats the `vendoai` umbrella); E-WIRE-004 now accepts
    a `<VendoRoot>` mount in ANY app layout (not just the root one); the
    unreachable-`/status` copy names the wire base `--url` expects; the probe
    dev-server's pipes are destroyed on stop so doctor's exit code always
    lands.
  - **Login write-preflight (M4).** `vendo login` proves `.env.local` is
    writable before opening (or resuming) a claim — a sandboxed run that cannot
    write the file fails up front instead of consuming the single-use claim and
    losing the minted key — and a redemption-time write failure now reads as a
    distinct write error (revoke + retry) instead of the timeout copy.

- a48b1b7: Wave 2 runtime fixes from the 0.4.x E2E certification campaign:

  - Mastra shim: open-schema guarded tools (extracted routes whose body shape
    is untyped) no longer execute with `{}` when the user dictated args.
    Mastra's provider schema-compat layers hard-close every object schema for
    strict-mode providers, so an open input reached the model as "takes no
    arguments"; the shim now bridges open inputs through one declared `args`
    property (JSON object or JSON-encoded string) and unwraps it before the
    guard, so approvals park — and replay — with the real arguments.
  - Failed app builds now carry their reason everywhere: `create()` re-throws
    with the classified reason in the message (the tool outcome the calling
    agent reads), logs the un-canned issue list to the operator terminal
    (previously a silent failure), and the app embed shows a retry hint for
    retryable failures. The generation engine now captures streamText's
    swallowed provider errors, so quota/timeout/no-key failures classify
    correctly instead of collapsing to "generation failed".
  - The dev model's no-usable-credential lines (missing provider package, no
    key at all) surface verbatim in the failed-build reason — the in-surface
    error now carries the actionable `npm install @ai-sdk/...` / `vendo login`
    instruction instead of `model could not produce a valid app`.
  - `@vendoai/ui` DonutChart no longer crashes on `undefined`/non-array data
    inside generated apps; it renders the designed empty state like the other
    Kit charts.

- Updated dependencies [a48b1b7]
  - @vendoai/apps@0.4.3
  - @vendoai/ui@0.4.3
  - @vendoai/automations@0.4.3
  - @vendoai/core@0.4.3
  - @vendoai/store@0.4.3
  - @vendoai/agent@0.4.3
  - @vendoai/actions@0.4.3
  - @vendoai/guard@0.4.3
  - @vendoai/mcp@0.4.3

## 0.4.2

### Patch Changes

- 8eaceb5: Login and first-turn fixes from the 0.4.1 E2E certification campaign:
  `vendo login` pending claims are now scoped per project directory —
  concurrent logins in different repos can no longer clobber or resume each
  other's ceremonies (the machine-global file could deliver one project's key
  to another). A matching pre-0.4.2 claim file is migrated automatically.
  `vendo init` now installs the model provider its resolved credential loads
  at runtime (`ai@^6` plus `@ai-sdk/anthropic@^3` / `@ai-sdk/openai@^3` /
  `@ai-sdk/google@^3`), so the first turn no longer 500s on a fresh install
  until the provider is added by hand.
  - @vendoai/core@0.4.2
  - @vendoai/store@0.4.2
  - @vendoai/agent@0.4.2
  - @vendoai/actions@0.4.2
  - @vendoai/guard@0.4.2
  - @vendoai/apps@0.4.2
  - @vendoai/automations@0.4.2
  - @vendoai/ui@0.4.2
  - @vendoai/mcp@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [b7a860f]
  - @vendoai/core@0.4.1
  - @vendoai/telemetry@0.3.1
  - @vendoai/actions@0.4.1
  - @vendoai/agent@0.4.1
  - @vendoai/apps@0.4.1
  - @vendoai/automations@0.4.1
  - @vendoai/guard@0.4.1
  - @vendoai/mcp@0.4.1
  - @vendoai/store@0.4.1
  - @vendoai/ui@0.4.1

## 0.4.0

### Minor Changes

- 5d89564: Extract registered host-component catalogs deterministically during sync, persist strict catalog artifacts and stale-safe review-only copy proposals, and load generated catalogs into the umbrella runtime with actionable malformed-file warnings. TypeScript is loaded only on the sync scan path and is no longer a production dependency of `@vendoai/actions`.
- 4b8ac66: Per-user connected accounts via the Composio broker (ENG-262). Connectors gain a subject-scoped `connections` capability (list/initiate/status/disconnect); the umbrella serves per-principal `/connections` endpoints with a Vendo Cloud broker seam behind `VENDO_API_KEY`; a Composio call missing a connection returns the new typed `connect-required` tool outcome, rendered by `VendoThread` as an inline connect card that retries after connecting; `ConnectedAccountsPanel` (list + disconnect) joins the chrome as the accounts tab. Composio tools carry curated risk (metadata hints + slug patterns) instead of a blanket `write`; the MCP connector accepts an async per-principal `headers` resolver with per-subject sessions; every connector execution is audited with its account identity.
- 2f67c65: Server-actions extractor behind the extractor seam (ENG-248): statically scan `"use server"` modules and inline functions with the TypeScript compiler API, interpret zod-validated and annotated inputs into JSON Schema (fail-closed to permissive + note otherwise), and emit the additive `server-action` binding kind (`module` + `exportName` + ordered `params`) within `vendo/tools@1`. Execution is direct in-process registration: `vendo init` now generates a `vendo-actions.ts` registration map wired into `createVendo({ serverActions })`; a server-action tool whose registration is missing fails closed with a clear error and no work performed. Risk labels fail closed — actions default `write`, the destructive word list applies, and unclassifiable or inline (non-importable) actions are emitted `disabled: true` with a note.
- ebc72e4: Runtime tool search and loadout (ENG-252). Add a deterministic `ActionsRegistry.search` query API (plus the pure `searchToolDescriptors`) that ranks the merged, enabled tool surface by intent, excluding disabled tools. The agent gains a `vendo_tools_search` meta-tool: it starts from a bounded initial loadout — the whole enabled surface when it fits the cap, an explicit curated list when provided, otherwise a read-first bounded default (`DEFAULT_MAX_INITIAL_TOOLS`) — and discovers and loads the rest mid-run. Loaded tools persist across turns within a thread and execute through the same guard-bound registry as any initially-enabled tool, so there is no unguarded path. The umbrella wires the search seam to the guard-bound registry.
- b29f65d: Init AI unification: theme extraction's model fallback now rides the same consent-gated AI pass as tool judgment (one consent covers both), running through the dev's `claude` CLI on PATH or a resolvable Agent SDK — nothing installed in the host app. The exact CSS pass still always writes `theme.json` first; `--theme slot=value` overrides any slot directly. Font-family names are canonicalized without optional CSS quotes.
- ff6b5d5: Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. `kind:"org"` and the `vendo:org:<id>` subject shape remain reserved but inert — no org storage, management surface, or activation ships in this release.

### Patch Changes

- b6def0f: Capture capability misses from embedded agent runs in a local JSONL sink and,
  when a Cloud API key and telemetry consent are present, upload them in bounded
  best-effort batches with the canonical enabled-tool surface.
- fbe4a49: Vendo Cloud gateway calls now send curated model aliases instead of raw provider ids. The `VENDO_API_KEY` dev-mode rung requests `vendo-default` (Sonnet) by default; `VENDO_CLOUD_MODEL` picks `vendo-fast` (Haiku) or `vendo-strong` (Opus). The box's Cloud inference rung pins `vendo-default` the same way (`VENDO_INFERENCE_MODEL` still overrides). The gateway remaps any non-alias to `vendo-default` (with an `x-vendo-model-remapped` warning header) during a grace window and will reject non-aliases after it. BYO provider keys are unaffected and keep real model ids.
- 023b3c0: Security hardening (ENG-251).

  - **Run-token anti-replay** (`@vendoai/apps`): run tokens now carry a random `jti`
    nonce. A run's jti is burned when its machine is torn down, so a captured token
    replayed afterwards is rejected at the proxy even though its HMAC and TTL still
    verify — shrinking the replay window from the full 15-minute TTL to the live run.
    A token remains valid for every callback of its own live run (tools, state,
    egress), so legitimate repeated proxy calls are unaffected. A token minted with
    no `jti` fails closed.
  - **Timing-safe `/tick` compare** (`@vendoai/vendo`): the `VENDO_TICK_SECRET`
    bearer check used plain string equality (a timing oracle). It now uses a
    WebCrypto HMAC-digest constant-time compare — edge-safe, no `node:crypto`.
  - **Bounded ephemeral-subject set** (`@vendoai/store`): the anonymous-visitor
    ephemeral-subject set is now a bounded LRU (10k) instead of growing until
    process restart. The subject registered for the current request is never the
    one evicted.

- 51f3fc9: Fix (ENG-353): heartbeat-armed idle-abort fallback for client disconnects the runtime never surfaces. Under `next dev` a real browser's graceful tab-close/navigate-away fires neither `request.signal` nor a stream cancel, so an abandoned turn ran to completion and burned provider tokens. The panel now beats `POST /threads/:id/heartbeat` while a turn streams; the first beat arms a server-side idle watchdog that aborts the turn through the same controller as the fast path after ~15s of silence. The fetch-abort fast path is unchanged, and consumers that never beat (curl/scripted clients) keep exact run-to-completion semantics.
- dab84c2: Performance: bound the automations tick and the agent's per-turn context.

  - **automations**: the tick fetches only schedule-triggered apps through an indexed
    `trigger_kind` ref (was a full scan of every app for every subject) and batches every
    schedule cursor into one query (was an N+1 get per app). Fired automations now execute
    with bounded parallelism (`tickConcurrency`, default 4) and an optional per-run timeout
    (`runTimeoutMs`), so one hung run cannot block other tenants or overrun the tick
    interval. `emit` likewise fetches only the subject's host-event apps. `/tick` still
    returns the same runIds.
  - **agent**: Anthropic prompt-caching breakpoints on the static system prompt and the
    stable history prefix (ignored by other providers); a default tool-output cap so one
    huge host-tool response cannot blow the context (`config.agent.toolOutputCap`); a new
    `historyWindow` knob bounding what is re-sent per turn (default: the full thread, as
    before); and thread listing that derives titles from a stored `title` instead of loading
    every thread's full message array.
  - **store**: btree indexes backing the `(created_at, id)` keyset pagination on
    `vendo_records` and the paged MCP tables, a generated `trigger_kind` column on
    `vendo_apps`, and a `title` column on `vendo_threads`. All applied as additive DDL — no
    schema-version bump and no data migration.

- Updated dependencies [49e9ccc]
- Updated dependencies [5d89564]
- Updated dependencies [0032a67]
- Updated dependencies [b6def0f]
- Updated dependencies [4b8ac66]
- Updated dependencies [a7d57b7]
- Updated dependencies [e9c538c]
- Updated dependencies [da4d3e8]
- Updated dependencies [a2ca8e2]
- Updated dependencies [b819ab2]
- Updated dependencies [75cb256]
- Updated dependencies [5093682]
- Updated dependencies [083a3b9]
- Updated dependencies [c42d41a]
- Updated dependencies [2f67c65]
- Updated dependencies [023b3c0]
- Updated dependencies [ebc72e4]
- Updated dependencies [fa0ad98]
- Updated dependencies [0e94fa6]
- Updated dependencies [0f17f39]
- Updated dependencies [7826a6e]
- Updated dependencies [7546de1]
- Updated dependencies [51f3fc9]
- Updated dependencies [0d2810b]
- Updated dependencies [dab84c2]
- Updated dependencies [ff6b5d5]
- Updated dependencies [8d5423d]
- Updated dependencies [0c10661]
  - @vendoai/core@0.4.0
  - @vendoai/store@0.4.0
  - @vendoai/mcp@0.4.0
  - @vendoai/actions@0.4.0
  - @vendoai/agent@0.4.0
  - @vendoai/automations@0.4.0
  - @vendoai/guard@0.4.0
  - @vendoai/ui@0.4.0
  - @vendoai/apps@0.4.0
