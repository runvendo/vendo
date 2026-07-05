# Flowlet Telemetry Design

Date: 2026-07-05
Status: Approved, pending implementation plan
Branch: yousefh409/telemetry

## Goal

Let the Flowlet team see how the open-source product is adopted and used, without collecting anything that creates privacy, compliance, or reputational risk. The design follows the established dev-tool norm (Next.js, Astro, Nuxt): anonymous, opt-out, loudly disclosed, one-line disable.

Four questions telemetry should answer, all scoped to the build and dev side only:

1. Adoption and install funnel: how many people install and complete setup, on which stack.
2. Feature usage: which components, tools, and automations get exercised during local development.
3. Reliability: where setup or the dev-time agent fails.
4. Health: whether installs stay active over time.

## Non-goals and hard boundaries

- No telemetry from customers' deployed production apps. Flowlet is an embedded library; phoning home from a host's production deployment would make Flowlet a data processor for the host's end users. Product events never fire when `NODE_ENV === 'production'`.
- No content, ever: no file paths, source code, prompts, generated UI, tool inputs or outputs, API keys, host app names, or environment values.
- No PII and no IP-linked identity. Only a locally generated random anonymous id.

## Two data layers

1. Distribution: Scarf for npm download attribution. Aggregate and anonymous by nature. Honors `DO_NOT_TRACK`.
2. Product events: PostHog (EU cloud, free tier, self-hostable later) for the anonymous, opt-out event stream.

## Architecture

A new package, `@flowlet/telemetry`, holds the shared client. It is dependency-light and consumed by both the CLI and the dev-side handler. Rationale: two callers need it, and a single package gives one auditable place for the event allowlist and consent logic.

Responsibilities of the package:

- A single `track` entry point: resolves consent, then fires the event to PostHog fire-and-forget with a short timeout, swallowing all failures.
- A consent resolver: a pure function over environment and config that returns whether telemetry is allowed.
- Anonymous identity management: read or create the random id in the config file.
- First-run notice: print once, record that it was shown.
- A closed event allowlist defined in one module, so the disclosure doc can mirror it exactly.

## What we collect

Every event is defined in a central allowlist. Nothing is free-form.

Base properties on all events: event name, anonymous id, Flowlet version, OS platform, Node version, CI flag.

CLI and build events:

- init started, completed, failed, including which step failed.
- provider detected (one of anthropic, openai, google).
- component count and tool count from an extraction.

Dev-time feature events (behind the non-production plus consent gate):

- agent run.
- component rendered, identified by catalog type name only.
- host tool invoked, identified by tool name only.
- automation created.
- error class (the error category string, never the message or stack contents).

## Identity and consent

- Anonymous id: a random UUID created once and stored at `~/.flowlet/telemetry.json`. Not derived from any machine or user attribute. Deleting the file rotates the id.
- Telemetry is disabled when any of these is true: `FLOWLET_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, a CI environment is detected, the config file records opt-out, or (for runtime callers) `NODE_ENV === 'production'`.
- The user can opt out with the env var or with `flowlet telemetry disable`, and re-enable with `flowlet telemetry enable`. `flowlet telemetry status` reports current state and the anonymous id.
- First run prints a short notice pointing at `TELEMETRY.md` and the disable command, then records that the notice was shown so it appears only once.

## Instrumentation points

- `flowlet-cli`: wrap `init`, `extract`, and the `publish` stub; add the `telemetry` subcommand group.
- `flowlet-next` and `flowlet-server` dev path: emit feature events behind the non-production plus consent gate.
- Root `package.json`: add Scarf for download attribution. Its postinstall must honor `DO_NOT_TRACK`.

## Safety invariants

Each of these is enforced by a test:

- The consent resolver returns disabled for every opt-out signal (env vars, `DO_NOT_TRACK`, CI, config-file opt-out).
- Runtime callers never emit when `NODE_ENV === 'production'`.
- Emitted payloads carry only allowlisted keys. A test asserts no event includes a disallowed key.
- The anonymous id is random, not derived from machine or user attributes.
- Every network call is fire-and-forget with a short timeout and swallows failure. Telemetry can never block or crash a build or dev server. This is the one place silent failure is correct, and it is documented as intentional.

## Disclosure

- `TELEMETRY.md` at the repo root lists exactly what is collected with real example payloads, mirrors the allowlist, and documents every opt-out path.
- README links to `TELEMETRY.md`.
- The first-run notice points users to both.

## Testing

- Unit: consent resolver truth table across all signals.
- Unit: payload allowlist enforcement.
- Unit: anonymous id persistence and first-run notice shown exactly once.
- Integration: `track` swallows a network failure and respects its timeout without throwing.

## Open items for the plan

- Resolved: PostHog US project. The write-only `phc_` project key is hardcoded as `DEFAULT_POSTHOG_KEY` in `@flowlet/telemetry` (safe to ship, capture-only), overridable via `FLOWLET_POSTHOG_KEY`.
- Confirm Scarf account and package registration for the published npm packages.
- Decide exact config file path convention (XDG vs `~/.flowlet`) during planning.
