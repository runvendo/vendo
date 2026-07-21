# Vendo Telemetry

Vendo collects anonymous, opt-out telemetry from build and development tooling so the project can understand setup success, feature use, and reliability. Product telemetry is build/dev-side only and never fires from a deployed production app.

## What Is Collected

Every event uses a random anonymous id plus the event properties listed here. The allowlist below mirrors `packages/vendo-telemetry/src/events.ts`; keys outside these sets are dropped before sending.

Every event carries the base properties `vendoVersion`, `osPlatform`, `nodeVersion`, `projectIdHash`, and `packageManager` (written *base* below). `packageManager` is a closed enum — `npm`, `pnpm`, `yarn`, or `bun` — read from the package manager's own user-agent env var, and omitted when unknown. `projectIdHash` is described under Anonymous Identity.

| Event | Properties |
| --- | --- |
| `init_started` | *base*, `framework` |
| `init_completed` | *base*, `framework`, `provider`, `llmSkipped`, `keyPrompt`, `command`, `componentsOffered`, `componentCount`, `remixOffered`, `remixWrapped`, `remixSkipped`, `toolCount`, `durationMs` |
| `init_failed` | *base*, `framework`, `failedStep` |
| `doctor_run` | *base*, `failures`, `warnings`, `wired` |
| `agent_run` | *base* |
| `error_class` | *base*, `errorClass` |

`init_completed` fields are all small integers or short enums: `command` is `init` only; `componentsOffered`/`componentCount` are the catalog picker's offered/accepted counts; `remixOffered`/`remixWrapped`/`remixSkipped` are the remix picker's anchor counts. `doctor_run` carries the health-check's hard-`failures` count, `warnings` count, and a `wired` bool. No event carries component names, ids, labels, file paths, keys, or any other content — counts and enums only.

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

Vendo telemetry never collects source code, file paths, prompts, generated UI, tool inputs or outputs, API keys, host app names, environment values, request bodies, error messages, or stack traces.

## Anonymous Identity

Vendo creates a random UUID and stores it in `~/.vendo/telemetry.json` with two preferences: `optedOut` and `noticeShown`. The id is not derived from a machine, account, project, host app, or environment value. Deleting the file rotates the id.

`projectIdHash` identifies a project opaquely so events from the same repo can be grouped. It is a one-way SHA-256 of the git origin URL (normalized so ssh and https spellings match), or of the `package.json` name when there is no remote, and omitted when neither exists. A fixed public salt (`vendo-telemetry-project-v1`) is prepended before hashing; the raw URL or name is never sent and cannot be recovered from the hash. Changing the remote rotates the hash.

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
