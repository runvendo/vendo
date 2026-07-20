# execution-v2 Wave 8 — the box agent IS the Claude Agent SDK

Live evidence for the engine swap: the Wave-3 thin loop is deleted and the
in-box agent is the Claude Agent SDK (Claude Code as a library), baked into
the base box template at build time. All runs on **real e2b + real Claude**.

Templates this campaign:
- **SDK (Wave 8)**: `pbgk5vxvhmtjmcn8lgeo` — built by `packages/apps/box/build-template.mjs`
  (npm-installs `@anthropic-ai/claude-agent-sdk@0.3.215` + peers into
  `/opt/vendo-box` at build time).
- **Thin loop (Wave 7 shipped config)**: `02ar6qdzqils9e3hgek5` — the Wave-7
  baseline template (scaffold + thin loop), reused for a same-day same-prompt A/B.

## 1. Both inference env shapes, headless in-sandbox (`smoke-env-shapes.mjs`)

The Wave-3 friction ("SDK fought the sandbox: size/auth") solved at the right
layers — size at template build, auth via env:

| shape | wiring | result |
| --- | --- | --- |
| BYO | `VENDO_INFERENCE_URL=https://api.anthropic.com` + sk-ant key → `ANTHROPIC_API_KEY` | **PASS** (`out-smoke-byo.txt`, 43.3s total incl. boot) |
| gateway | `VENDO_INFERENCE_URL=https://console.vendo.run/api/v1` + `VENDO_API_KEY` → `ANTHROPIC_BASE_URL` override | **PASS** (`out-smoke-gateway.txt`, 38.0s total incl. boot) |

Both runs: the SDK ran fully headless (no login, no onboarding), wrote a
zero-dep fn server, self-verified, and returned the structured result through
the in-process `report_done` MCP tool; `POST /fn/ping → 200 {"result":{"pong":true}}`
verified from outside the box.

## 2. Same-prompt A/B: thin loop vs SDK (`measure-box-build.mjs`)

Same prompts, same model (`claude-sonnet-4-5`), same day, interleaved runs.
`layer3` = the Wave-7 kanban served-app build (prompt verbatim from the Wave-7
measure script, so Wave-7 numbers stay comparable); `graduation` = the Wave-3
invoice-chaser 2-fn server build. Full console outputs in `out-*.txt`, agent
logs in `agent-log-*.txt`.

| run | engine | mode | build | result |
| --- | --- | --- | --- | --- |
| thin-l3-1 | thin loop | layer3 | 142.3s¹ | ok, servesUi |
| thin-l3-2 | thin loop | layer3 | 129.3s | ok, servesUi, GET / 200 |
| sdk-l3-1 | **SDK** | layer3 | 101.2s¹ | ok, servesUi |
| sdk-l3-2 | **SDK** | layer3 | 92.6s | ok, servesUi, GET / 200 |
| thin-grad-1 | thin loop | graduation | 46.2s | ok, both fns verified |
| thin-grad-2 | thin loop | graduation | 46.2s | ok, both fns verified |
| sdk-grad-1 | **SDK** | graduation | 61.8s | ok, both fns verified |
| sdk-grad-2 | **SDK** | graduation | 66.8s | ok, both fns verified |

¹ run-1 console output was lost to a session restart; the number is the
ISO-stamped agent-log span (task start → done), which slightly *under*counts
the BUILD wall clock — the comparison is conservative in the thin loop's favor.

**Read honestly, both directions:**
- **Layer-3 (the expensive build): SDK mean ~96.9s vs thin ~135.8s — ~29%
  faster** (and 37% under the Wave-7 shipped-config mean of 154.0s). The SDK's
  better tool-use batches work into fewer, more effective turns (~7 assistant
  turns vs the thin loop's 13-24), which is exactly the model-round-trip
  economics lever Wave 7 identified.
- **Graduation (the small fn-only build): SDK mean ~64.3s vs thin ~46.2s —
  ~18s slower.** The SDK carries a fixed per-task cost (CLI subprocess spawn,
  session init, its larger system prompt) that dominates short tasks. Quality
  was equal (all 4 runs ok, fns verified).
- Every run in both engines succeeded; no rewrite-class failures anywhere in
  the campaign.

## 3. THE GATE (`live-gate.mjs`)

The Wave-3 invoice-chaser graduation re-run through the SDK harness against
the real wired `createVendo` server (cloudflared tunnel for `/box` callbacks),
**clean pass, exit 0** (`live-gate-transcript.txt`):

1. tree app created;
2. the server instruction **graduates** it: machine provisioned, the SDK box
   agent writes `chaseInvoices` + `getDigest` + `vendo.json` (8am schedule +
   `httpbin.org` egress), `pendingEgress` parked;
3. the **egress approval card** decided (`egressApproved: ["httpbin.org"]`);
4. the **schedule fires** via the authenticated wire tick:
   `{fn: "chaseInvoices", cron: "0 8 * * *", scheduledFor: 2026-07-21T08:00Z,
   status: "ok"}` — the box did allowlisted egress and wrote the durable
   digest row through `/box` over the tunnel;
5. **reopening** shows the digest in the tree (`hasDigest: true`);
6. **layer-3**: a second app's 2→3 edit built the served kanban through the
   SDK agent (scaffold ridden — only `fns.js` + `index.html` written; 4 fns),
   document flipped to `ui: "http"`, and the machine-ingress page answered
   `GET / → 200 text/html`.

Both gate apps deleted at the end (`apps.delete` → machine + snapshot reaped).

Gate-harness note (host-side script mechanics, not product behavior): the
schedule step fakes the host clock Date-only to the next 8am UTC occurrence
after the fire baseline — the baseline is the schedule-sync time, so a
same-day earlier hour would honestly not be due. Two early gate attempts
died to session churn on the driving machine, not to any product failure;
crashed attempts' sandboxes were swept (account at zero after the campaign).

## Notes

- The control-port protocol did not change; `machine.editApp`, graduation and
  the engine needed zero edits (verified by the unchanged conformance suites
  `box-harness.test.ts` / `box-agent.test.ts`).
- The box passes an explicit model (default `claude-sonnet-4-5`,
  `VENDO_INFERENCE_MODEL` overrides — the knob still works, exercised by
  `box-agent-sdk.test.ts`). Without the pin the SDK would default to its
  `sonnet` alias, which floats with SDK releases; the pin keeps box economics
  a deliberate choice.
- All sandboxes destroyed at the end of every run (`finally` kill in the
  scripts; `apps.delete` → `destroyResources` in the gate; account swept
  after the campaign).
