# execution-v2 Wave 9 — escalation-ladder live gate

Rung (a) end to end on a REAL model (`claude-sonnet-4-6`, key from the
canonical env file): the canonical prompt **"email me a digest of unpaid
invoices at 8am"** must become a working STEPS automation in seconds, fire
through the EXISTING automations tick, and land its result in a store row the
tree's query shows — with **zero sandbox creation** (no sandbox adapter is
even composed; the blocks are wired exactly the way `createVendo` wires them,
including the Wave-9 `armAutomation` seam and demo-bank's ask-on-write
policy).

Run: `node docs/verification/exec-v2-wave9/live-gate.mjs` (needs
`ANTHROPIC_API_KEY`).

## Result: PASS (transcript: `live-gate-transcript.txt`)

- **Setup 21.1s** (committed transcript; earlier runs of the day measured
  28.0s and 50.7s — the time is two model calls: the automation plan + the
  tree rebind). Box graduation for the same ask costs minutes of in-box agent
  round trips.
- Authored plan (model-written, validated): `host_listUnpaidInvoices` →
  `host_sendEmail` (digest body built in jsonata from the read step's real
  rows) → `vendo_apps_data_put` into the declared `unpaid-invoices`
  collection. Trigger `{kind: "schedule", cron: "0 8 * * *"}`.
- Arming ran the automations engine's own `enable()` (the 07 §3 grant-capture
  flow): three standing-grant approvals parked and rode
  `EditResult.automation.pendingGrants`; the gate approves them the way the
  dock's approvals surface would.
- Fired via `automations.tick()` at the next synthetic 8am UTC; run `ok`
  across all three steps; the email carries the host tool's REAL invoice rows
  (data-honesty asserted: hand-typed digests fail the gate — and fail plan
  validation).
- `open()` resolves the rebind-added `vendo_apps_data_list` query and the
  digest rows are visible in the tree payload.
- No machine anywhere: the document never grew `machine`, and no sandbox
  adapter existed to provision one.
