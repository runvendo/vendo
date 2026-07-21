# PostHog Analytics: Console, Docs, and CLI Enrichment

Date: 2026-07-21
Status: approved (pending Yousef's spec review)
Repos: this repo (CLI telemetry + docs-site) and vendo-web (console)

## Goal

Give Vendo solid product analytics and session recordings across its three
instrumentable surfaces, and enough CLI telemetry to understand what kinds of
projects people run Vendo against and how those runs turn out.

## Decisions (locked with Yousef)

1. **One PostHog project for everything.** All surfaces reuse the existing
   write-only project key already shipped in `vendo-telemetry` and baked into
   the marketing-site bundle. Events are separated by a `surface` property
   (and PostHog's automatic `$host`), not by project.
2. **Console gets full posthog-js** (approach A): autocapture, session
   recordings, `identify`, plus a small set of manual activation events.
3. **Recording masking = inputs + secrets**: `maskAllInputs` on, and
   `ph-no-capture` on API-key reveal and other secret-bearing components.
   Free-text page content stays visible so replays are useful.
4. **CLI telemetry has two lanes:**
   - *Anonymous lane* (everyone): rich enums and counts only, plus a salted
     one-way hashed project id. Stays within TELEMETRY.md's existing
     counts-and-enums promise; no names, paths, or content, matching industry
     norms (Turborepo/Nx/Astro/Storybook).
   - *Cloud lane* (only when a `VENDO_API_KEY` is configured): events
     additionally carry account-linking data (hash of the API key) and richer
     result detail. Documented as Vendo Cloud usage, not anonymous telemetry.
5. **Docs analytics via Mintlify's built-in PostHog integration** with session
   recording enabled.

## Design

### 1. Console (vendo-web)

- posthog-js initialized from a client provider mounted in the console root
  layout, covering both the login and signed-in route groups.
- Key handling mirrors `vendo-telemetry`: baked default project key constant
  with an env override. No dependence on undocumented Cloudflare build env.
- First-party ingestion: an `/ingest` rewrite in the console's Next config
  proxies events and the recorder script to PostHog US, so ad blockers
  (ubiquitous among developer users) don't drop data. The console deploys via
  OpenNext on Cloudflare Workers, which supports Next rewrites.
- Config: autocapture on, SPA pageviews via posthog-js history-change
  defaults, default persistence (first-party cookie/localStorage — acceptable
  in a signed-in console), super property `surface: "console"`.
- Identity: `identify(user.email)` when the signed-in layout mounts (email is
  the console's login identity); `posthog.reset()` on logout.
- Session recording enabled, `maskAllInputs: true`, `ph-no-capture` class on
  key-reveal/secret components (keys pages, claim/invite tokens).
- Manual activation events (~5): signup completed, API key created,
  deployment claimed, plan upgraded/checkout, first-run viewed. Exact list
  finalized in the implementation plan against the console's routes.
- Tests follow the existing marketing-site `tests/analytics.test.tsx`
  pattern; UI verified in a real browser with screenshots in the PR, plus a
  live check that events and a recording land in PostHog.

### 2. Docs site (this repo, `docs-site/docs.json`)

- Add Mintlify's `integrations.posthog` block with the shared project key and
  `sessionRecording: true`. Mintlify proxies ingestion through its own
  endpoint; no other work.

### 3. CLI telemetry (this repo)

**Anonymous lane (all users, existing consent gates unchanged):**

- New base properties:
  - `projectIdHash`: salted SHA-256 of the git remote origin URL, falling
    back to the package.json name; omitted when neither exists. Opaque and
    non-reversible; enables distinct-project counts, per-project retention,
    and cross-command journeys.
  - `packageManager`: npm/pnpm/yarn/bun enum derived from the install user
    agent.
- Enriched `init_completed`: adds `typescript` (bool), `router`
  (app/pages/none), `engine` (claude/codex/npx-engine/none),
  `apiDetectMethod` (route-scan/zod/none), `routeCount`, `themeExtracted`
  (bool).
- New events:
  - `extract_completed`: framework, method, route/tool counts, ok, duration.
  - `command_run`: `{ command, ok, failedStep?, durationMs }` with a closed
    command enum — wired into every currently-dark command: extract, theme,
    eject, playground, refine, sync, cloud-init, mcp.
- Everything stays behind the existing allowlist + value-bounding machinery
  and the existing opt-outs (`VENDO_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, CI,
  production runtime).

**Cloud lane (only when `VENDO_API_KEY` is present and well-formed):**

- Events additionally carry `cloudKeyHash` (SHA-256 of the API key) and
  `cloud: true`. The console already stores key hashes, so account joins
  happen on Vendo's side; PostHog never receives the key itself.
- Richer result detail permitted on cloud events: fuller config enums and
  more specific sanitized error classes (still never raw error messages,
  paths, or code).
- Documented in TELEMETRY.md as a distinct section ("When Vendo Cloud is
  configured") and referenced from the cloud docs, so the two lanes and their
  different postures are explicit.

**Docs sync:** TELEMETRY.md event table and the docs-site environment/
telemetry references updated to mirror `events.ts` exactly (an existing test
enforces the mirror).

### 4. Manual PostHog-UI steps (Yousef)

- Enable "Record user sessions" in the project settings.
- Add `console.vendo.run` and `docs.vendo.run` to "Authorized domains for
  recordings."

## Non-goals

- No marketing-site changes: it keeps its cookieless, no-recording posture.
- No feature flags, surveys, or experiments infrastructure.
- No raw app names, dependency lists, file paths, error text, or code in any
  lane.
- No separate PostHog projects or key rotation.

## Delivery

Two PRs, one per repo, each green on build/test/typecheck/lint per repo
rules; console PR includes browser screenshots. CLI PR and console PR are
independent and can land in either order.
