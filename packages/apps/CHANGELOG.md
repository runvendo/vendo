# @vendoai/apps

## 0.4.0

### Minor Changes

- 0e94fa6: Secrets egress fetch shim (ENG-290 M4, 06-apps §4.3/§4.5 option B).

  - **In-sandbox fetch shim**: every machine now carries a runtime-owned
    `/app/.vendo/fetch-shim.cjs`, loaded at boot via `NODE_OPTIONS --require` by
    the rung-2/3 boot convention, the rung-4 served-app scaffold's `start.sh`,
    and Modal's create command. Outbound `fetch(externalUrl)` from app code is
    rewritten into `POST {VENDO_PROXY_URL}/egress` authenticated by the run
    token, so plain `fetch` with a declared secret handle in a header or body
    authenticates to allowlisted hosts — substitution stays exclusively at the
    proxy, outside the sandbox. Internal requests (relative URLs, the proxy
    itself, loopback) are never rewritten; a refused egress surfaces as an
    ordinary fetch `TypeError`, never a leak.
  - **Interchange**: `.vendoapp` exports exclude the runtime-owned shim, and
    imports rebuild machines with the current shim (an archive can never smuggle
    a modified one in).
  - Env-gated live lanes prove the shim on real E2B (Modal lane parked on
    missing `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`, exactly like the ladder
    lanes).

- 7826a6e: feat(apps): guarded per-secret in-sandbox exposure toggle (ENG-345)

  Adds the off-by-default exception path to the Option B secrets gateway: an
  owner-only, per-secret × per-app toggle that injects a secret's real value into
  the sandbox env instead of a handle. Flipping it on is a high-risk action gated
  by the guard's existing approval flow; every run with an exposed secret emits an
  audit event; and the grant lives outside the app document so it never travels
  with a share, remix, fork, export, or import (copies always revert to handles).

- 8d5423d: Generation speed: add an opt-in `onTiming` seam around `modelEngine.create` (per-lane first-paint / complete timing + token usage) and a best-effort `runtime.prewarm()` page-open model warm-up. Additive — no change to create/paint/render behavior.

### Patch Changes

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

- 7546de1: Inject the standard run environment when `importApp` provisions a machine (ENG-347, 06-apps §4.2).

  Import rebuilt an app-directory machine with `env: { PORT }` only, bypassing the
  shared env helper the create/edit path uses. The secrets egress fetch shim then
  declined to install (it requires `VENDO_PROXY_URL` + `VENDO_RUN_TOKEN`), so an
  imported rung-2/3 app could not reach host tools or the egress endpoint until it
  was re-edited. Provisioning now routes through the machine cache, baking the same
  §4.2 run environment (`PORT`, `VENDO_PROXY_URL`, a freshly minted `VENDO_RUN_TOKEN`,
  and declared secret handles) into the rebuilt snapshot, so an imported app reaches
  tools/egress with no subsequent edit.

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
- Updated dependencies [0032a67]
- Updated dependencies [b6def0f]
- Updated dependencies [4b8ac66]
- Updated dependencies [fa0ad98]
- Updated dependencies [51f3fc9]
- Updated dependencies [ff6b5d5]
  - @vendoai/core@0.4.0
