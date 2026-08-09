# @vendoai/telemetry

## 0.5.0

### Minor Changes

- 4fa477a: The package now exports only what its consumers actually import. Seven names left the public surface — `createTelemetry`, `DEFAULT_POSTHOG_KEY`, `CLOUD_PROP_KEYS`, `resolveConsent`, `saveConfig`, `configPath`, and `maybeShowNotice` — none of which was imported by the CLI, the console, or any example. `EVENT_ALLOWLIST` stays: the integration fixture's telemetry-wire seam test consumes it. `initTelemetry` remains the one way to build a client, and the first-run notice it shows moved with it into the entry module (the standalone `notice.ts` is gone). The edge build sheds the same names (`resolveConsent` and its no-op `saveConfig`), keeping the two entries' surfaces aligned.

## 0.4.1

### Patch Changes

- 5724311: The first-run telemetry notice advertises an opt-out that exists.

  The one-time consent notice told every new user "disable now: `vendo telemetry
disable`". No such command has ever existed — the CLI has no `telemetry`
  branch, and the only occurrence of that string anywhere in the repo was the
  notice itself — so the single actionable instruction in the privacy notice
  failed with an unknown-command error. It now names `VENDO_TELEMETRY_DISABLED=1`,
  which the very next line already listed and which TELEMETRY.md has documented
  all along.

  The test that covers the notice now checks every environment variable the
  notice names is one `envOptOut` actually honors, and that the notice names no
  `vendo …` command at all: this package deliberately depends on no `@vendoai`
  package, so it can never verify that a CLI command exists.

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
