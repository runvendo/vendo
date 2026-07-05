# Flowlet Telemetry

Flowlet collects anonymous, opt-out telemetry from build and development tooling so the project can understand setup success, feature use, and reliability. Product telemetry is build/dev-side only and never fires from a deployed production app.

## What Is Collected

Every event uses a random anonymous id plus the event properties listed here. The allowlist below mirrors `packages/flowlet-telemetry/src/events.ts`; keys outside these sets are dropped before sending.

| Event | Properties |
| --- | --- |
| `init_started` | `flowletVersion`, `osPlatform`, `nodeVersion`, `framework` |
| `init_completed` | `flowletVersion`, `osPlatform`, `nodeVersion`, `framework`, `provider`, `llmSkipped`, `componentCount`, `toolCount`, `durationMs` |
| `init_failed` | `flowletVersion`, `osPlatform`, `nodeVersion`, `framework`, `failedStep` |
| `agent_run` | `flowletVersion`, `osPlatform`, `nodeVersion` |
| `error_class` | `flowletVersion`, `osPlatform`, `nodeVersion`, `errorClass` |

Example payload:

```json
{
  "api_key": "phc_...",
  "event": "init_completed",
  "distinct_id": "3f2a1c2d-4b5a-4678-9abc-1d2e3f4a5b6c",
  "properties": {
    "flowletVersion": "0.0.0",
    "osPlatform": "darwin",
    "nodeVersion": "v22.3.0",
    "framework": "next",
    "provider": "configured",
    "llmSkipped": false,
    "componentCount": 4,
    "toolCount": 7,
    "durationMs": 1200
  }
}
```

## What Is Never Collected

Flowlet telemetry never collects source code, file paths, prompts, generated UI, tool inputs or outputs, API keys, host app names, environment values, request bodies, error messages, or stack traces.

## Anonymous Identity

Flowlet creates a random UUID and stores it in `~/.flowlet/telemetry.json` with two preferences: `optedOut` and `noticeShown`. The id is not derived from a machine, account, project, host app, or environment value. Deleting the file rotates the id.

## Opt Out

Any one of these disables product telemetry:

- `flowlet telemetry disable`
- `FLOWLET_TELEMETRY_DISABLED=1`
- `DO_NOT_TRACK=1`
- CI environments, detected from `CI`
- Production runtime, when `NODE_ENV=production`

Run `flowlet telemetry enable` to clear the local opt-out flag. Scarf also honors `DO_NOT_TRACK`.

## Where Data Goes

Product events are sent to PostHog US Cloud using a write-only project key. Network calls are fire-and-forget, use a short timeout, and failures are swallowed so telemetry cannot break builds or dev servers.

Published package download attribution is wired through Scarf for npm installs. Scarf registration is an owner-operated package setup step.
