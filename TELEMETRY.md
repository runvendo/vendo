# Vendo Telemetry

Vendo collects anonymous, opt-out telemetry from build and development tooling so the project can understand setup success, feature use, and reliability. Product telemetry is build/dev-side only and never fires from a deployed production app.

## What Is Collected

Every event uses a random anonymous id plus the event properties listed here. The allowlist below mirrors `packages/vendo-telemetry/src/events.ts`; keys outside these sets are dropped before sending.

Every event carries the base properties `vendoVersion`, `osPlatform`, `nodeVersion`, `projectIdHash`, and `packageManager` (written *base* below). `packageManager` is a closed enum — `npm`, `pnpm`, `yarn`, or `bun` — read from the package manager's own user-agent env var, and omitted when unknown. `projectIdHash` is described under Anonymous Identity.

| Event | Properties |
| --- | --- |
| `init_started` | *base*, `framework` |
| `init_completed` | *base*, `framework`, `provider`, `llmSkipped`, `keyPrompt`, `command`, `componentsOffered`, `componentCount`, `remixOffered`, `remixWrapped`, `remixSkipped`, `toolCount`, `durationMs`, `typescript`, `router`, `engine`, `apiDetectMethod`, `routeCount`, `themeExtracted`, `frameworkVersion`, `reactVersion`, `zodVersion`, `typescriptVersion` |
| `init_failed` | *base*, `framework`, `failedStep`, `errorClass` |
| `doctor_run` | *base*, `failures`, `warnings`, `wired` |
| `extract_completed` | *base*, `framework`, `method`, `routeCount`, `toolCount`, `ok`, `durationMs`, `frameworkVersion`, `zodVersion` |
| `command_run` | *base*, `command`, `ok`, `failedStep`, `errorClass`, `durationMs` |
| `agent_run` | *base* |
| `error_class` | *base*, `errorClass` |

`init_completed` fields are all small integers, bools, or short enums: `command` is `init` only; `componentsOffered`/`componentCount` are the catalog picker's offered/accepted counts; `remixOffered`/`remixWrapped`/`remixSkipped` are the remix picker's anchor counts; `typescript` and `themeExtracted` are bools; `router` is the closed enum `app` | `pages` | `none`; `engine` (which AI-polish engine ran) is `claude` | `codex` | `npx-engine` | `none`; `apiDetectMethod` is `route-scan` | `zod` | `none`; `routeCount` is the count of route-bound tools. `frameworkVersion`/`reactVersion`/`zodVersion`/`typescriptVersion` are bare dependency version strings from the host `package.json` with range prefixes stripped (`^15.3.1` → `15.3.1`) — non-identifying, omitted when the dependency is absent.

`init_failed` and `command_run` carry `failedStep` (a short step enum) and `errorClass` (the error's constructor name, e.g. `TypeError`) — never message text. `command_run` fires once per tracked CLI command run; its `command` is the closed enum `extract` | `theme` | `eject` | `playground` | `refine` | `sync` | `cloud-init` | `mcp` — each a standalone `vendo <command>` except `cloud-init`, which fires from the cloud step inside `vendo init` — with `ok` a bool and `durationMs` an integer. `extract_completed` reports `vendo extract --apply`'s result: `method` is the same `route-scan` | `zod` | `none` enum, plus route/tool counts, an `ok` bool, duration, and the two version strings. `doctor_run` carries the health-check's hard-`failures` count, `warnings` count, and a `wired` bool. No event carries component names, ids, labels, file paths, keys, or any other content — counts and enums only.

Example payload:

```json
{
  "api_key": "phc_...",
  "event": "init_completed",
  "distinct_id": "3f2a1c2d-4b5a-4678-9abc-1d2e3f4a5b6c",
  "properties": {
    "vendoVersion": "0.0.0",
    "osPlatform": "darwin",
    "nodeVersion": "v22.3.0",
    "projectIdHash": "9b2b...64-hex-chars...c1e0",
    "packageManager": "pnpm",
    "framework": "next",
    "provider": "configured",
    "llmSkipped": false,
    "keyPrompt": "provided",
    "command": "init",
    "componentsOffered": 6,
    "componentCount": 4,
    "remixOffered": 3,
    "remixWrapped": 2,
    "remixSkipped": 0,
    "toolCount": 7,
    "durationMs": 1200
  }
}
```

## What Is Never Collected

Vendo telemetry never collects source code, file paths, prompts, generated UI, tool inputs or outputs, API keys, host app names, environment values, request bodies, raw error messages, or stack traces. (Cloud-configured installs send a scrubbed `errorDetail` — see When Vendo Cloud Is Configured.) The `packageManager` name is classified into a closed enum from the npm user-agent env var; no raw env values are sent.

## Anonymous Identity

Vendo creates a random UUID and stores it in `~/.vendo/telemetry.json` with two preferences: `optedOut` and `noticeShown`. The id is not derived from a machine, account, project, host app, or environment value. Deleting the file rotates the id.

`projectIdHash` identifies a project opaquely so events from the same repo can be grouped. It is a one-way SHA-256 of the git origin URL (normalized so ssh and https spellings match), or of the `package.json` name when there is no remote, and omitted when neither exists. A fixed public salt (`vendo-telemetry-project-v1`) is prepended before hashing; the raw URL or name is never sent and cannot be recovered from the hash. Changing the remote rotates the hash.

## When Vendo Cloud Is Configured

Setting a well-formed `VENDO_API_KEY` (`vnd_` plus 40 hex characters) switches telemetry into the cloud lane. Nothing else activates it, and every opt-out below still applies — an opted-out user with a cloud key sends nothing.

In the cloud lane every event additionally carries `cloud: true` and `cloudKeyHash`, the SHA-256 of the API key. The Vendo console stores key hashes, so cloud events can be joined to the owning account; PostHog never receives the key itself.

Cloud-lane events may also carry these extra properties (the `CLOUD_PROP_KEYS` set in `packages/vendo-telemetry/src/events.ts`), allowed on every event: `projectName`, `repoHost`, `errorDetail`, `connectionsConfigured`, `toolkitsEnabled`, `servedApps`, `experimentalFlags`, and the per-stage init timings `detectMs`, `engineMs`, `themeMs`, `wiringMs`, `componentsMs`. Without a valid key these keys are stripped before sending, even if the tooling passes them.

`errorDetail` is the only free-text property Vendo ever sends. It is scrubbed first: file paths, email addresses, and secret-shaped strings (API keys, bearer tokens, long hex or base64 runs) are replaced with fixed tokens like `[path]` and `[secret]`, then the result is capped at 200 characters. The telemetry client re-scrubs every `errorDetail` as defense-in-depth even when the caller already did.

## Opt Out

Any one of these disables product telemetry:

- `VENDO_TELEMETRY_DISABLED=1`
- set `"optedOut": true` in `~/.vendo/telemetry.json`
- `DO_NOT_TRACK=1`
- CI environments, detected from `CI`
- Production runtime, when `NODE_ENV=production`

Set `"optedOut": false` in `~/.vendo/telemetry.json` to clear the local opt-out flag. Scarf also honors `DO_NOT_TRACK`.

## Where Data Goes

Product events are sent to PostHog US Cloud using a write-only project key. Network calls are fire-and-forget, use a short timeout, and failures are swallowed so telemetry cannot break builds or dev servers.

Published package download attribution is wired through Scarf for npm installs. Scarf registration is an owner-operated package setup step.
