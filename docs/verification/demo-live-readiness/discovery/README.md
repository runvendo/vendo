# Discovery-discipline live proof (criteria 13, 14)

Date: 2026-07-26 · lane: discovery-discipline · branch: `yousefh409/demo-discovery`

Raw, recomputable counter output: [`transport-counter.log`](./transport-counter.log).
Every total in this README is the literal line count of a block in that file.

## What was measured, and how

The criteria are stated in **connector HTTP round-trips per turn**, so the
counter lives at the transport itself:

- `VENDO_DEBUG_CONNECTOR_HTTP=1` makes every connector request log
  `[vendo:connector-http] <connector> <method> <path>` (seam in
  `packages/core/src/fetch.ts`, wired at `composioFetch` and both cloud fetch
  seams). The flag is read once at module load, so adapters keep the
  adapter-rule invariant of never reading the environment per call.
- The repeatable assertion is `packages/vendo/src/discovery-budget.live.test.ts`
  (skipped unless `COMPOSIO_API_KEY` + `ANTHROPIC_API_KEY` are present). It
  stubs the transport, composes a real `createVendo`, runs a real agent turn,
  and asserts the criteria verbatim.

**Totals are totals.** `/tools/execute` calls count like every other
round-trip. An earlier version of the live test excluded them after a run
measured 10; that was a reinterpretation of a signed criterion and has been
reverted. The real defect was the harness: with no host tools, the agent read
the user's actual Gmail to synthesise spending data that Maple gets from host
tools. The harness now serves one host tool from a local HTTP route — the
Maple shape, where spending comes from the host and the connector is only used
to send — and the criterion passes on the total.

**A failed turn proves nothing.** The live test fails loudly on a connector
transport failure (DNS, refused, 5xx), on a stream error part, and on a turn
that never reached the connector at all. Low counts and missing cards look
identical to success otherwise.

**Posture note (deviation, recorded).** The canonical key file holds no
`VENDO_API_KEY`, so the live runs use the **BYO Composio** broker — the same
connector code path the gate, scoping, memo, and prompt changes sit on. The
Cloud-broker posture is covered by mocked-transport assertions:
`server.test.ts` ("connectorApps scopes the auto-composed cloud connector AND
the connect catalog") and `cloud-tools.test.ts` ("apps scoping also scopes the
discovery index").

**Measurement note.** `next dev` is not a valid environment: hot-reload
re-instantiates `createVendo` on every compile, resetting every
process-lifetime memo (one dev run showed 18 `/api/v3/tools` calls ≈ 9
instances). The chat UI also polls `/api/vendo/connections`, and each poll is
one broker round-trip through the uncached wire route (out of scope per the
contract; recorded in `PARKED.md` P2). All numbers below come from a
**production build** with the turn driven over the API and no browser
attached.

## Scenario (b) — Gmail NOT connected · criteria 13 budget + 14 ✅

Real Maple, production build, subject `vendo-demo`, Gmail EXPIRED on the live
Composio account.

| Observation | Result | Criterion |
| --- | --- | --- |
| Connector round-trips, total for the turn | **6** | 13: ≤ 6 ✅ |
| Connect cards (`data-vendo-connect`) | **1** | 14: exactly one ✅ |
| Approval parts (`data-vendo-approval`) | **0** | 14: zero before connect ✅ |
| Stream error parts | **0** | turn genuinely succeeded ✅ |
| `GET /api/vendo/approvals` after the turn | `[]` | 11: store untouched ✅ |

Sequence — no catalog walk, no speculative execute:

```
composio GET /api/v3/tools                ← first-request schema load, scoped set
composio GET /api/v3/connected_accounts   ← loadout seed (connected toolkits)
composio GET /api/v3/toolkits/gmail       ← discovery index, scoped set only
composio GET /api/v3/toolkits/slack       ← discovery index, scoped set only
composio GET /api/v3/connected_accounts   ← connect gate, pre-guard
composio GET /api/v3/connected_accounts
```

Screenshot: [`maple-connect-card-no-approval.png`](./maple-connect-card-no-approval.png)
— one connect card; the activity feed reads **“Gmail send email — Connect
required”**, never “pending approval”. Host reads (`host_getProfile`,
`host_getSpendingInsights`) still auto-ran by rule, so the agent could show the
summary it would have sent.

## Criterion 9 live — scoped catalog ✅

Screenshot: [`scoped-connect-catalog.png`](./scoped-connect-catalog.png). The
connect tray advertises exactly **Gmail and Slack** — the demo's scoped set —
instead of the broker's full catalog (the live Composio account holds 17
distinct toolkits; the unscoped cloud posture exposed ~56).

## Scenario (a) — Gmail CONNECTED · criterion 13 ✅ (host caveat parked)

`discovery-budget.live.test.ts`, live against the real broker as entity
`flowlet-demo` (the workspace entity holding an ACTIVE Gmail connection — the
same live entity `composio.live.test.ts` uses):

| Observation | Result |
| --- | --- |
| Boot round-trips (one-time schema load) | **2** — one per scoped toolkit |
| Turn round-trips, **total** incl. `/tools/execute` | **3** (≤ 6) ✅ |
| Connect card on the connected path | none ✅ |

**Host caveat.** Completing Gmail OAuth for Maple's own `vendo-demo` subject
requires the human's Google password (Orca's browser offers three of Yousef's
Google accounts, all signed out) — an agent session cannot and must not
complete it. Maple's own connected-path run is therefore parked; see
`PARKED.md` P1. What is proven live, on the real broker, is the criterion's
budget on the connected path.

**Nothing was sent.** The policy asks on write and no approval was granted, so
the guarded `gmail_GMAIL_SEND_EMAIL` parked instead of delivering mail.

## Reproducing

```bash
# Repeatable live assertion (both criteria, transport-counted)
set -a; source ~/orca/workspaces/flowlet/.env; set +a; unset VENDO_API_KEY
pnpm --filter @vendoai/vendo exec vitest run src/discovery-budget.live.test.ts

# The Maple run, by hand
cd apps/demo-bank
set -a; source ~/orca/workspaces/flowlet/.env; set +a; unset VENDO_API_KEY
export MAPLE_STORE=local VENDO_DEBUG_CONNECTOR_HTTP=1 AUTH_SECRET=<any> \
       MAPLE_DEMO_PASSWORD=maple-demo VENDO_BASE_URL=http://localhost:3400
npx next build && npx next start --port 3400 > /tmp/maple.log 2>&1 &
# log in over the API, mark the log, POST the ask to /api/vendo/threads,
# then count the window:
grep -c 'vendo:connector-http' /tmp/maple.log
```
