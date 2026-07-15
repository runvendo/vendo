# Install DX Wave 2 Spike — riding authed CLI sessions as dev-mode providers

**Linear:** ENG-337 · **Date:** 2026-07-15 · **Machine:** Yousef's mac
(claude CLI 2.1.210 logged in via claude.ai; codex-cli 0.144.4 logged in via
ChatGPT plan; node v24.2.0)

## RECOMMENDATION: full-tools riding

Both rungs work end-to-end **with Vendo host tools bridged in and approval
semantics intact**, at interactive latency (~0.2–0.4 s median TTFT overhead vs
a direct env key on short turns). The tools-free fallback is not needed.
Wave 2 should build the credential resolver with all four rungs and wire both
riders as full-tool providers behind one narrow interface (sketch below).

## Approval-semantics verdict: SURVIVE — on both rungs

The key question was whether a destructive tool call can be **parked for user
approval and later resumed**. Yes, on both:

- **Claude Agent SDK:** the `canUseTool` permission callback is an async
  function per tool call. We awaited a broker promise for 3 000 ms (simulated
  human), then returned `{behavior: "allow"}`; the in-process MCP tool then
  executed and the turn completed with the real result. Denial
  (`{behavior: "deny", message}`) feeds a refusal back to the model — same
  shape as Vendo's `pending-approval` → grant/deny flow.
- **Codex app-server:** dynamic tool calls arrive as a **server→client JSON-RPC
  request** (`item/tool/call`). The client simply doesn't answer until the
  human decides; we replied after the 3 000 ms park and the turn resumed.
  Parking is unbounded by protocol design (request/response, no timeout seen).

Evidence (broker log, codex run — identical shape on the claude run):

```
approval-parked  apr_1784138778801 @1784138778801
approval-granted apr_1784138778801 @1784138781803   ← +3002 ms
tool-executed    vendo_payments_send @1784138781803
```

and the model's answer after the park, on both rungs, contained the real
confirmation id produced by the (fake) host API:

```
claude: "Payment sent — confirmation id is conf_spike_001."
codex:  "I'll send 1,250 cents to Acme Water Co. … conf_spike_001"
```

## Latency

Scenarios: `short` = "Reply with exactly: pong" (no tools); `tool-read` = one
read-risk host-tool round-trip; `tool-approve` = one write-risk call with a
3 000 ms approval park (park included in totals). 4 trials (2 for approve),
same machine, same hour. Raw records: `results/latency.json`.

| rung · scenario | trials | TTFT ms (min/med/max) | total ms (min/med/max) |
|---|---|---|---|
| env-key claude-opus-4-8 · short | 4 | 1070 / 1619 / 1992 | 1180 / 1731 / 2131 |
| claude-agent-sdk (claude-opus-4-8[1m]) · short | 4 | 1681 / 1877 / 2122 | 1767 / 1911 / 2239 |
| claude-agent-sdk · tool-read | 4 | 3231 / 4127 / 8722 | 3277 / 4313 / 8904 |
| claude-agent-sdk · tool-approve (+3000 park) | 2 | 7242 / 10767 / — | 7434 / 11004 / — |
| claude-agent-sdk · warmup (spawn + first turn) | 1 | 11531 | 12014 |
| codex-app-server (gpt-5.6-sol) · short | 4 | 1135 / 1921 / 3689 | 1267 / 2152 / 3825 |
| codex-app-server · tool-read | 4 | 1418 / 3346 / 4474 | 3986 / 5493 / 7678 |
| codex-app-server · tool-approve (+3000 park) | 2 | 1449 / 1894 / — | 7160 / 15506 / — |
| codex-app-server · spawn + thread/start | 1 | — | 1532 |

Readings:

- **Steady-state interactive latency is fine on both riders.** Median short-turn
  TTFT: baseline 1.6 s → claude rider 1.9 s → codex rider 1.9 s.
- **First-turn cost differs a lot.** Codex is ready in ~1.5 s. The Claude rider's
  first turn (process spawn + session init + turn) took ~12 s — the persistent
  process must be started eagerly (e.g. when the dev server boots), not on the
  first user message. Model choice untested; a smaller `options.model` likely
  shrinks this.
- Tool turns are 2-model-turn round-trips; 3–5 s medians are consistent with the
  baseline model doing the same loop.

## What worked / failed per rung

### Rung: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.210)

Worked:
- Rides the CLI login with zero configuration: we `delete
  process.env.ANTHROPIC_API_KEY` and the SDK used the `claude.ai` subscription
  auth (verified: no key in env; `system:init` reported model
  `claude-opus-4-8[1m]`).
- One persistent session over `query()` streaming-input mode (an
  `AsyncIterable<SDKUserMessage>` we push turns into); 10+ sequential turns on
  one live process.
- In-process MCP server (`createSdkMcpServer` + `tool()` with zod v4 shapes);
  tools appear as `mcp__vendo__*`.
- `canUseTool` sees every tool call (MCP tools included), can allow/deny, and
  can block arbitrarily long — approval parking works.
- Built-in tools locked out via `disallowedTools` + a deny-all-non-vendo rule in
  `canUseTool` (defense in depth). `settingSources: []` keeps the host machine's
  user/project settings and hooks out of the ridden session.
- `result` messages carry `usage` + `total_cost_usd` per turn (recorded in
  `results/latency.json`).

Gotchas (cost real time):
- **Streaming-input mode emits nothing — not even `system:init` — until the
  first user message is yielded.** Any "wait for init after start" logic
  deadlocks. Send a warmup turn.
- SDK 0.3.210 requires **zod ^4** (peer dep); Vendo packages are on zod 3 —
  keep the provider package's zod isolated from `@vendoai/core`'s.
- Without `settingSources: []` the ridden session loaded this machine's global
  hooks (visible as `system:hook_started` messages) — a real product must never
  inherit the dev's personal Claude Code config.

### Rung: Codex app-server (codex-cli 0.144.4)

Worked:
- Rides `~/.codex/auth.json` (ChatGPT plan) automatically; no key, no flags.
- `codex app-server` = newline-delimited JSON-RPC 2.0 over stdio. Handshake:
  `initialize` (with `capabilities.experimentalApi: true`) → `initialized`
  notification. Persistent conversation: `thread/start` → many `turn/start`.
- **First-class dynamic tools — no MCP server needed.** `thread/start` accepts
  `dynamicTools: [{type:"function", name, description, inputSchema}]`
  (experimental, gated on `experimentalApi`). Codex executes them by sending
  the client an `item/tool/call` request; the client's response
  (`{contentItems:[{type:"inputText",text}], success}`) is the tool result.
  Delaying that response is the approval park.
- Turn lifecycle notifications: `item/agentMessage/delta` (TTFT + text),
  `turn/completed` (status). `sandbox: "read-only"` + `approvalPolicy:
  "untrusted"` + deny-all on harness approval requests keeps the agent away
  from shell/filesystem.
- Protocol shapes were verified against the installed binary via
  `codex app-server generate-ts --out <dir>` — regenerate on codex upgrades.

Caveats:
- The whole surface is marked **[experimental]** by upstream; `dynamicTools`
  is additionally feature-gated. Pin the codex version in wave 2 and add a
  doctor check (`codex app-server generate-json-schema` diff) for drift.
- Model was `gpt-5.6-sol` (the plan's default); per-thread `model` override
  exists in `thread/start`/`turn/start` but was not exercised.
- No usage/cost fields observed on `turn/completed` in this run (status only).

### Rung: env key (baseline)

Direct `POST /v1/messages` stream with `ANTHROPIC_API_KEY` from the canonical
key file. Median short-turn TTFT 1.6 s / total 1.7 s. This stays the top rung
of the ladder — explicit beats implicit.

## Wave-2 API sketch (credential resolver + provider)

```ts
// packages/vendo/src/dev-creds/resolve.ts
export type DevCredential =
  | { rung: "env-key"; provider: "anthropic" | "openai" | "google"; apiKey: string }
  | { rung: "claude-session" }                    // consent asked by the wizard before use
  | { rung: "codex-session" }                     // officially sanctioned by OpenAI
  | { rung: "vendo-cloud"; apiKey: string }       // starter allowance (wave 3)
  | { rung: "none" };

export async function resolveDevCredential(): Promise<DevCredential>;
// detection order (spec §2): env keys → `claude auth status` (JSON, loggedIn)
// → `codex login status` / ~/.codex/auth.json → VENDO_API_KEY → none.
// Pure read-only detection; consent for session rungs is the wizard's job.
```

Two consumer shapes, because Vendo has two call sites:

1. **Tool-less generation** (extraction `--deep`, on-brand UI seeding, doctor's
   one real turn): a plain ai-SDK `LanguageModelV2` whose `doGenerate/doStream`
   forwards one prompt into the persistent rider session and streams text back.
   Trivial on both riders (this spike's `short` scenario is exactly that path).

2. **The dev-mode chat loop** (full tools): invert the loop. Today
   `createVendo` hands `streamText` a model plus ai-SDK tools built by
   `buildAgentTools` (packages/agent). For rider rungs, wave 2 should add a
   narrow seam next to the model:

   ```ts
   interface VendoTurnRunner {
     startSession(opts: { tools: ToolDescriptor[]; system: string }): Promise<void>;
     runTurn(input: UserTurn, sink: TurnSink): Promise<TurnResult>;
     // sink receives text deltas + tool lifecycle events;
     // tool execution calls back into the SAME guard/registry path
     // (guard.check → "ask" → pending-approval part → park → registry.execute)
     dispose(): Promise<void>;
   }
   ```

   The rider owns the model loop; Vendo keeps owning **tool execution and
   consent** — the bridge handler calls `guard.check` + `registry.execute`
   exactly like `buildAgentTools.execute` does today, so approval UI parts,
   grants and the abandoned-approval semantics are unchanged. This is what the
   spike measured (its `ApprovalBroker` stands in for the guard's ask path).
   A strict `LanguageModelV2` emulation that re-emits harness tool calls as
   ai-SDK tool-call parts and resumes parked handlers on the next `doStream`
   is possible but adds cross-call correlation for no user-visible gain — not
   recommended for wave 2.

Runtime notes for the resolver's rider providers:
- Spawn the persistent process at dev-server boot (Claude's 12 s first turn).
- One session per Vendo thread maps cleanly on both riders (Claude: one
  streaming `query()` per thread; codex: one `threadId` per thread).
- Production stays key-only; the resolver refuses session rungs when
  `NODE_ENV === "production"` (spec §2's "honest 503" unchanged).

## Repro

```sh
cd spikes/install-dx-creds && pnpm build
node dist/run-codex.js                          # needs codex CLI logged in
node dist/run-claude.js                         # needs claude CLI logged in
ANTHROPIC_API_KEY=… node dist/run-baseline.js   # env-key control
```

Protocol bindings for the installed codex:
`codex app-server generate-ts --out /tmp/codex-proto` (method names used here:
`initialize`, `initialized`, `thread/start`, `turn/start`, `item/tool/call`,
`item/agentMessage/delta`, `turn/completed`).

## Deviations from the spec's assumptions

- The spec's creds-research line said "CLI-wrapped providers cannot execute the
  host tools bound into Vendo's own agent loop". **That is now false for both
  vendors**: the Agent SDK executes in-process MCP tools under `canUseTool`,
  and codex 0.144.x executes client-registered `dynamicTools` over JSON-RPC.
  The compliant-gateway argument may still apply commercially, but not
  technically.
- Codex needed **no MCP bridge at all** — dynamic tools are cleaner than the
  planned "in-process MCP" wording (MCP config override stays as fallback).
- ToS posture per Yousef's standing decision: proceeding as-approved on the
  Anthropic rung; OpenAI rung is officially sanctioned. Not re-litigated here.
