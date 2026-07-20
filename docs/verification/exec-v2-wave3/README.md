# execution-v2 Wave 3 — the agent in the box + graduation + the invoice-chaser gate

Live verification of Wave 3: the base box template, the in-box coding agent,
graduation 1→2, egress approval, the schedule fire, and durable `/box` writes —
all on **real e2b + real Claude**, driven against the real wired `createVendo`
server through a public cloudflared tunnel (so the box's `/box` callbacks reach
the host store).

## What ran live

1. **Base box template** built on e2b (`packages/apps/box/build-template.mjs`):
   Node + the harness (`bootstrap.mjs`/`harness.mjs`/`agent-loop.mjs`). Template
   id from this run: `h5pf20fap7ows6io81kr`.
2. **In-box agent** — proven writing and serving an fn on a real box against
   real Claude before the gate (control port → `POST /agent/task` → the agent
   writes a zero-dep server, restarts it, serves `POST /fn/<name>`).
3. **The invoice-chaser gate** (`live-gate-transcript-clean-pass.txt`), every
   step green:
   - a tree app generates;
   - a server instruction **graduates** it: a machine is provisioned, the box
     agent writes `chaseInvoices` + `getDigest` + `vendo.json` (8am schedule +
     `httpbin.org` egress), and the tree's board query is rebound to
     `fn:getDigest`;
   - the **egress approval card** parks and the owner approves it
     (`egressApproved: ["httpbin.org"]`);
   - the **schedule fires** (`chaseInvoices`, `scheduledFor` 08:00, `status: ok`):
     the box does allowlisted `httpbin.org` egress and writes a durable digest
     row through `/box`;
   - **re-opening** the app shows the digest in the tree:
     `{count: 3, totalCents: 48500, invoices: […]}`.

The digest row was written BY the box agent's fn through the `/box` callback
over the tunnel — proving the full box→host durable-write loop.

## Evidence files

- `live-gate-transcript-clean-pass.txt` — the full clean-pass console transcript
  (every step's data inline).
- `live-gate-result.json` — the structured per-step summary of the clean pass.

## Honest notes (generation-time variance)

The box agent and the fn-binding tree edit are real model generations, so the
gate is not bit-deterministic:

- **Box edit time varies.** The invoice-chaser build finished in ~2 min on the
  clean pass but occasionally churned past the 8-minute default. The operator
  knob `VENDO_BOX_EDIT_TIMEOUT_MS` (host env) tunes the long-poll budget.
- **fn-binding validity varies.** The tree-edit model occasionally emits invalid
  wire; graduation retries it (3 attempts, focused directive) and, if it still
  fails, keeps the working tree and reports the miss in `issues` (the app never
  breaks). On the clean pass the binding validated first try.
- **Post-resume boot race.** A memory-snapshot resume boots the app fresh, so an
  fn/manifest request right after a wake can hit the provider's transient 502;
  `requestAppWithBootRetry` retries that window (fixed a flaky schedule fire).

Every sandbox created was destroyed; snapshots from the runs were reaped
(`destroyResources` on delete, plus a manual sweep of the template's sandboxes).

## Reproduce

```
# 1. build the base box template
cd packages/apps/box && E2B_API_KEY=… node build-template.mjs vendo-box
# → set VENDO_BOX_TEMPLATE=<id> on the host

# 2. run the host with the e2b adapter + a public origin, then drive a prompt:
#    "watch my unpaid invoices and email me a digest at 8am; show a status board"
#    graduate → approve the egress card → POST /api/vendo/tick → reopen.
```
