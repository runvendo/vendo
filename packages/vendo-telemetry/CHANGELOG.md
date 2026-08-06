# @vendoai/telemetry

## 0.4.0

### Minor Changes

- a004031: **BREAKING:** drop the `extract_completed` event and five cloud prop keys
  (`connectionsConfigured`, `toolkitsEnabled`, `servedApps`,
  `experimentalFlags`, `componentsMs`) from the allowlists, and remove `try`
  from the `command_run` command enum.

  None of these were ever emitted — no producer existed anywhere in the tree —
  so TELEMETRY.md was over-declaring what Vendo collects. The disclosure now
  matches what is actually sent. `EventName` no longer includes
  `extract_completed`.

## 0.3.3

### Patch Changes

- 923cf59: Telemetry can no longer keep a process alive after its work is done. On a
  captive-portal network — one that accepts the TCP connection to the capture
  endpoint and then never answers — `vendo init` printed its summary and sat
  there for another ten seconds doing nothing; `DO_NOT_TRACK=1` removed the pause
  entirely, naming telemetry as the handle. The cause is Node's global fetch
  (undici): aborting the request does not destroy a socket that is still
  connecting, so it stayed alive until undici's own 10s connect timeout.

  The default transport is now a raw request whose socket is unref'd the moment
  it exists, so a stranded telemetry POST can never be the last handle holding
  the CLI open, under any network condition. The timeout — unchanged at 1.5s — is
  now the only thing a caller ever waits on. An injected `fetchImpl` still takes
  the fetch path, so hosts and tests that supply their own are unaffected.

  Also adds `VENDO_POSTHOG_HOST`, which points capture events at a self-hosted
  PostHog instead of the shipped US cloud (`VENDO_POSTHOG_KEY` already set the
  project key).

## 0.3.2

### Patch Changes

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

## 0.3.1

### Patch Changes

- b7a860f: Release pipeline hardening: the release gate now runs the PostgreSQL store
  suite like CI does, and publishing uses npm trusted publishing (OIDC) with
  provenance — no npm tokens anywhere. This patch is the first release cut
  end-to-end by the automated pipeline.
