# The box (execution-v2 Wave 3; agent engine = Claude Agent SDK since Wave 8)

The reproducible base box template: **Node + the in-box coding agent harness**.
Every graduated app's machine boots from this snapshot. The agent lives in the
box; "edit this app" sends a prompt to the box and the agent writes the server
code, runs it, curls its own endpoints, and reports a structured result.

## Files (baked into the template)

- `bootstrap.mjs` — the entrypoint the template's start command runs.
- `harness.mjs` — `createHarness()`: the control-port server + app supervisor
  (zero-dependency).
- `agent-sdk.mjs` — `runAgentTask()`: the agent engine — the **Claude Agent
  SDK** (Claude Code as a library, `@anthropic-ai/claude-agent-sdk`), headless
  `query()` with its shell + file tools, working dir `/app`, structured result
  via an in-process `report_done` MCP tool. The SDK (plus its peers) is
  npm-installed into `/opt/vendo-box/node_modules` at **template-build time**,
  so install size is a template concern, never a wake concern.
- `build-template.mjs` — the e2b template builder (the recipe).
- The conversational session door and its SDK loop — `turn-routes.mjs` and
  `claude-turn.mjs` — are baked from `@vendoai/harnesses` (the claude-code
  driver owns its box-side half): the routes from that package's
  `box/turn-routes.mjs`, the runner from its compiled
  `dist/claude-code/claude-turn.js`, both staged in here at bake time for the
  e2b `copy()` reason below. The supervisor delegates every `/session/*`
  request to them.
- The universal app template — Vite + React 19 with `@vendoai/ui` installed —
  is baked from `packages/box-template` (staged in here at bake time, for the
  same e2b `copy()` reason as `claude-turn.mjs`). It lands at
  `/opt/vendo-box/template`, its deps at `/opt/vendo-box/deps` with the
  template's `node_modules` a symlink to them, so `cp -a template/. /app/` is a
  warm start that copies a link rather than hundreds of megabytes. ONE universal
  template, baked once per Vendo release: nothing company-specific is baked, and
  the host's brand and components arrive as files under `/app/.vendo/host/`.

## The two ports

- **`$PORT`** (default 8080) — the **app** the agent writes: it serves
  `POST /fn/<name>` and `GET /vendo.json`. The app owns this port.
- **`8811`** (`VENDO_CONTROL_PORT`) — the **harness** control port, the host's
  door to the agent (reached via `SandboxMachine.request({ port: 8811 })`):
  - `GET  /agent/health`
  - `POST /agent/env { env }` — persist re-injected boundary env + restart app.
    The set is the WHOLE boundary and it replaces the provision-time one: the app
    and the agent get it plus the machine's own vars (`PATH`, `HOME`, …), so a
    secret the owner revoked is gone from the box at the next restart.
  - `POST /agent/task { prompt, context? }` → `202 { taskId }` (one at a time)
  - `GET  /agent/task/<id>` → `{ status, result?, log }`
  - `POST /agent/restart-app`

The control-port protocol is engine-agnostic and did NOT change in the Wave-8
engine swap — nothing outside the box needed edits.

## The app the agent maintains

- `/app/.vendo/run` — a Procfile-style one-line start command (e.g.
  `node server.js`). The supervisor runs it with the boundary env and restarts
  it on edits and env re-injection.
- `/app/vendo.json` — the manifest (`schedules`, `egress`).

## Inference

Reads `VENDO_INFERENCE_URL` / `VENDO_INFERENCE_KEY` (BYO Anthropic key, or the
Cloud metered gateway behind the same two vars) and maps them onto the SDK's
env auth: `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`. `VENDO_INFERENCE_MODEL`
still picks the model (default `claude-sonnet-4-5`; without the pin the SDK
would default to its `sonnet` alias). On the Cloud rung the host injects
`vendo-default` — the gateway serves only the curated aliases
`vendo-default` / `vendo-fast` / `vendo-strong`.

## Build

```
E2B_API_KEY=... node build-template.mjs vendo-box
# → prints the template id; set VENDO_BOX_TEMPLATE=<id> on the host.
```
