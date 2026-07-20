# Wave 3 — browser evidence (demo-bank / Maple)

The invoice-chaser arc from the Wave 3 live gate (`../README.md`), reproduced
end-to-end **in a real browser** on demo-bank with real e2b + real Claude,
`VENDO_BASE_URL` pointed at a cloudflared quick tunnel so the box's `/box`
callbacks reach the host store. Real Auth.js login (`yousef@maple.com`),
everything driven through Maple's own UI (`/vendo/apps` workspace + the
Ask Maple approvals surface); the only step outside the browser is the
external-cron `POST /api/vendo/tick`, fired with `curl` exactly as a cron
would.

## The arc

1. **`1-tree-generated.png`** — "Show a status board for my unpaid invoices…"
   creates the rung-1 tree app (Unpaid Invoices board) on the Apps workspace.
2. **`2-egress-approval-card.png`** — the Wave-3 graduation instruction in the
   app's Edit box provisions a machine; the in-box agent writes
   `chaseInvoices` + `getDigest` + `vendo.json`; the declared `httpbin.org`
   egress parks the approval card (CRITICAL / `vendo_egress_allow`, exact tool
   inputs) on the Ask Maple surface.
3. **`3-egress-approved-activity.png`** — after clicking Approve: the card is
   gone, the activity feed shows the egress decision and the app update;
   `egressApproved: ["httpbin.org"]` landed on the doc.
4. **`tick-response.json`** — the real authenticated wire tick
   (`POST /api/vendo/tick`, `VENDO_TICK_SECRET` bearer) fired the schedule:
   `chaseInvoices`, `scheduledFor 2026-07-20T03:20:00Z`, `status: ok` — the box
   did its allowlisted `httpbin.org` egress and wrote the digest row through
   `/box` over the tunnel.
5. **`4-reopened-digest-tree.png`** — the reopened app renders the digest from
   `fn:getDigest`: count 3 and the three invoices (INV-001 Acme Corp, INV-002
   Widget Inc, INV-003 Gadget LLC, totalCents 48500).

## Honest notes (this run)

- **Cron:** the instruction asked for `*/5 * * * *` instead of the gate's
  `0 8 * * *` so the *real* wire tick could fire inside the session window;
  the 8am semantics were proven in the transcript gate. Nothing else about
  the tick path differs.
- **Box edit variance (again):** the first graduation attempt churned past a
  20-minute `VENDO_BOX_EDIT_TIMEOUT_MS` and rolled back cleanly (tree intact,
  the designed discard-rollback); the retry graduated in 2.6 min.
- **fn-binding variance (again):** graduation rebound the queries but the
  visible board bindings kept the host-tool `/data/` envelope segment, so the
  board rendered "—" until two follow-up *tree* edits (one attempt emitted
  invalid reshape wire and fail-softed with the app intact) bound
  `/transactions/count` and `/transactions/invoices`. The
  ambiguous-server-term context gate held: all follow-ups stayed tree edits.
- **Finding — e2b TTL vs a busy box:** the e2b adapter passes
  `timeoutMs` (default 300 s) to both `create` and `resume` and never extends
  it, so a box in active use dies at TTL mid-session. The in-process live ref
  then answers 502 `"The sandbox was not found"` on every fn call until the
  idle sweep (or a host restart) clears it; the next wake resumes from the
  durable snapshot and recovers fully. Follow-up: extend/refresh the provider
  timeout on activity, and drop a live entry on sandbox-not-found instead of
  retrying it.
- **Host setup:** demo-bank does not ship the optional `e2b` peer dep; the
  run installed it into the app's `node_modules` (the documented BYO step —
  `pnpm add e2b` in a real host). No manifest changes are committed.

Cleanup: the app was deleted in-client (destroyResources reaped the machine),
and an account-wide sweep killed every remaining paused sandbox (72, including
debris from earlier lanes' runs).
