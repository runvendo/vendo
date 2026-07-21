# @vendoai/core

## 0.4.1

### Patch Changes

- b7a860f: Release pipeline hardening: the release gate now runs the PostgreSQL store
  suite like CI does, and publishing uses npm trusted publishing (OIDC) with
  provenance — no npm tokens anywhere. This patch is the first release cut
  end-to-end by the automated pipeline.

## 0.4.0

### Minor Changes

- 49e9ccc: Add database-level atomic claims for multi-instance OAuth code redemption and refresh-token rotation.
- 0032a67: Add optional atomic record claims and revision CAS, use them to deduplicate multi-instance automation firing, and abort in-process agentic runs when stopped.
- 4b8ac66: Per-user connected accounts via the Composio broker (ENG-262). Connectors gain a subject-scoped `connections` capability (list/initiate/status/disconnect); the umbrella serves per-principal `/connections` endpoints with a Vendo Cloud broker seam behind `VENDO_API_KEY`; a Composio call missing a connection returns the new typed `connect-required` tool outcome, rendered by `VendoThread` as an inline connect card that retries after connecting; `ConnectedAccountsPanel` (list + disconnect) joins the chrome as the accounts tab. Composio tools carry curated risk (metadata hints + slug patterns) instead of a blanket `write`; the MCP connector accepts an async per-principal `headers` resolver with per-subject sessions; every connector execution is audited with its account identity.
- ff6b5d5: Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. `kind:"org"` and the `vendo:org:<id>` subject shape remain reserved but inert — no org storage, management surface, or activation ships in this release.

### Patch Changes

- b6def0f: Capture capability misses from embedded agent runs in a local JSONL sink and,
  when a Cloud API key and telemetry consent are present, upload them in bounded
  best-effort batches with the canonical enabled-tool surface.
- fa0ad98: Test hardening (ENG-255): wire v8 coverage across every package with a ratcheted
  per-package line-coverage floor enforced in CI (`pnpm test:coverage`), remove
  `--passWithNoTests` so empty suites fail, add dedicated unit tests for the
  thin/zero-test hot paths (core schemas + component-map, agent prompt, store
  run/audit helpers, automations engine), and add cross-block journeys J8 (actions
  OpenAPI sync callable over the wire), J9 (Postgres durability + restart drill),
  J10 (multi-tenant concurrency isolation), and J11 (telemetry allowlist wire).
  No runtime behavior changes.
- 51f3fc9: Fix (ENG-353): heartbeat-armed idle-abort fallback for client disconnects the runtime never surfaces. Under `next dev` a real browser's graceful tab-close/navigate-away fires neither `request.signal` nor a stream cancel, so an abandoned turn ran to completion and burned provider tokens. The panel now beats `POST /threads/:id/heartbeat` while a turn streams; the first beat arms a server-side idle watchdog that aborts the turn through the same controller as the fast path after ~15s of silence. The fetch-abort fast path is unchanged, and consumers that never beat (curl/scripted clients) keep exact run-to-completion semantics.
