# The box

The reproducible base box template: **Node + the Claude Code session runner**.
A box boots from this snapshot, serves the conversational turn door, and
supervises whatever process the app directory declares.

## Files (baked into the template)

- `bootstrap.mjs` — the entrypoint the template's start command runs.
- `harness.mjs` — `createHarness()`: the control-port server + app supervisor,
  zero-dependency.
- `build-template.mjs` — the e2b template builder (the recipe).
- `turn-routes.mjs` and `claude-turn.mjs` are baked from `@vendoai/harnesses`
  (the claude-code driver owns its box-side half): the routes from that
  package's `box/turn-routes.mjs`, the runner from its compiled
  `dist/claude-code/claude-turn.js`, both staged in here at bake time for the
  e2b `copy()` reason the builder explains. The supervisor delegates every
  `/session/*` request to the routes. **ONE Claude Code integration**: the
  runner is also what `machine: "local"` runs on a host. The Agent SDK (plus its
  peers) is npm-installed into `/opt/vendo-box/node_modules` at
  **template-build time**, so install size is a template concern, never a wake
  concern.

## The two ports

- **`$PORT`** (default 8080) — the app process the box supervises. The app owns
  this port.
- **`8811`** (`VENDO_CONTROL_PORT`) — the harness control port, the host's door
  into the box (reached via `SandboxMachine.request({ port: 8811 })`):
  - `/session/**` — the conversational turn door (`turn-routes.mjs`)
  - `GET  /agent/health`
  - `POST /agent/env { env }` — persist re-injected boundary env + restart app.
    The set is the WHOLE boundary and it replaces the provision-time one: the app
    gets it plus the machine's own vars (`PATH`, `HOME`, …), so a secret the
    owner revoked is gone from the box at the next restart.
  - `POST /agent/restart-app`

## The app directory

- `/app/.vendo/run` — a Procfile-style one-line start command (e.g.
  `node server.js`). The supervisor runs it with the boundary env and restarts
  it on edits and env re-injection.

## Inference

Reads `VENDO_INFERENCE_URL` / `VENDO_INFERENCE_KEY` (BYO Anthropic key, or the
Cloud metered gateway behind the same two vars) and maps them onto the SDK's
env auth: `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`. `VENDO_INFERENCE_MODEL`
still picks the model. On the Cloud rung the host injects `vendo-default` — the
gateway serves only the curated aliases `vendo-default` / `vendo-fast` /
`vendo-strong`.

## Build

```
E2B_API_KEY=... node build-template.mjs vendo-box
# → prints the template id; set VENDO_BOX_TEMPLATE=<id> on the host.
```
