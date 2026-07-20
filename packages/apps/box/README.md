# The box (execution-v2 Wave 3)

The reproducible base box template: **Node + the in-box coding agent harness**.
Every graduated app's machine boots from this snapshot. The agent lives in the
box; "edit this app" sends a prompt to the box and the agent writes the server
code, runs it, curls its own endpoints, and reports a structured result.

## Files (zero-dependency runtime `.mjs`, baked into the template)

- `bootstrap.mjs` — the entrypoint the template's start command runs.
- `harness.mjs` — `createHarness()`: the control-port server + app supervisor.
- `agent-loop.mjs` — `runAgentTask()`: the agentic loop (shell + file tools,
  model over the Anthropic-compatible Messages API).
- `build-template.mjs` — the e2b template builder (the recipe).

## The two ports

- **`$PORT`** (default 8080) — the **app** the agent writes: it serves
  `POST /fn/<name>` and `GET /vendo.json`. The app owns this port.
- **`8811`** (`VENDO_CONTROL_PORT`) — the **harness** control port, the host's
  door to the agent (reached via `SandboxMachine.request({ port: 8811 })`):
  - `GET  /agent/health`
  - `POST /agent/env { env }` — persist re-injected boundary env + restart app
  - `POST /agent/task { prompt, context? }` → `202 { taskId }` (one at a time)
  - `GET  /agent/task/<id>` → `{ status, result?, log }`
  - `POST /agent/restart-app`

## The app the agent maintains

- `/app/.vendo/run` — a Procfile-style one-line start command (e.g.
  `node server.js`). The supervisor runs it with the boundary env and restarts
  it on edits and env re-injection.
- `/app/vendo.json` — the manifest (`schedules`, `egress`).

## Inference

Reads `VENDO_INFERENCE_URL` / `VENDO_INFERENCE_KEY` (BYO Anthropic key today;
the Cloud metered gateway is the Wave-5 slot-in behind the same two vars).

## Harness note (loud, per the Wave-3 charter)

`agent-loop.mjs` is a **thin loop over the Anthropic Messages API**, not the
Claude Agent SDK. The SDK's CLI-sized install and login plumbing fought the
base-template budget; the control-port protocol is engine-agnostic, so the SDK
can slot in behind `runAgentTask()` later with no host-side change.

## Build

```
E2B_API_KEY=... node build-template.mjs vendo-box
# → prints the template id; set VENDO_BOX_TEMPLATE=<id> on the host.
```
