# @vendoai/spike-install-dx-creds

**SPIKE — not shipped.** Install DX wave 2, step 1 (ENG-337): can the machine's
authed **Claude Code** and **Codex CLI** sessions power Vendo's dev-mode agent
loop as persistent-process providers — with Vendo's host tools bridged in and
Vendo's approval semantics intact — at interactive latency?

Verdict, latency table, transcripts and the wave-2 API sketch live in
**[REPORT.md](./REPORT.md)**. Raw per-trial records: `results/latency.json`.

## What's inside

- `src/vendo-tools.ts` — stand-ins for Vendo host tools (one read-risk, one
  write-risk) + `ApprovalBroker`, the park-until-human-approves simulator.
- `src/claude-rider.ts` — persistent Claude Agent SDK session riding the
  `claude` login: streaming-input `query()`, in-process MCP server
  (`createSdkMcpServer`), consent routed through `canUseTool`.
- `src/codex-rider.ts` — persistent `codex app-server` (JSON-RPC over stdio)
  riding the ChatGPT-plan login: experimental `dynamicTools` on `thread/start`,
  tool execution via server→client `item/tool/call`, consent = delayed reply.
- `src/baseline.ts` — direct Anthropic Messages API with an env key (what
  dev-mode does today when a key exists).
- `src/run-*.ts` — key/auth-gated measurement scripts (never part of `pnpm test`).

## Install (standalone, not part of the workspace)

This spike needs **zod ^4** (Claude Agent SDK peer) while the repo is on zod 3;
as a workspace member it flipped zod peer resolution to 4.x for every ai-SDK
consumer (packages/agent, packages/ui, fixtures). It is therefore excluded in
`pnpm-workspace.yaml` and carries its own lockfile:

```sh
cd spikes/install-dx-creds
pnpm install --ignore-workspace
```

## Run the gates

`pnpm build && pnpm test && pnpm typecheck` — no network, no credentials.

## Reproduce the measurements

Requires: `claude` CLI logged in, `codex` CLI logged in (ChatGPT plan), and —
for the baseline only — `ANTHROPIC_API_KEY` in the environment.

```sh
pnpm build
node dist/run-codex.js       # rides ~/.codex ChatGPT-plan login
node dist/run-claude.js      # rides the claude CLI login (unsets ANTHROPIC_API_KEY itself)
set -a; source ../../../.env-with-keys; set +a   # or however you load the key
node dist/run-baseline.js    # env-key control
```

Each run appends to `results/latency.json` and prints a summary table.
