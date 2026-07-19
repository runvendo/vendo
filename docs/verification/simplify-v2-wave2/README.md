# Wave 2 demo-bank browser smoke (2026-07-17)

Manual verification of the flows Wave 2 rewired, driven in a real browser
against `pnpm --filter demo-bank dev` with live model keys and
`VENDO_BASE_URL=http://localhost:3000`.

- `smoke-1-maple-home.png` — Maple renders on the rewired stack (disk-backed
  sessions, route-table wire, single-path threads).
- `smoke-2-approval-card.png` — a destructive `host_transferMoney` call parks
  as a CRITICAL approval ceremony showing the REAL tool inputs (05-guard §6).
- `smoke-3-transfer-complete.png` — approve on the card → decide 200 → resume
  replays the approved call once → `POST /api/transfers?...memo=wave+2+smoke+final`
  200 → transfer Posted with a transaction reference.

Also observed live: the approval-CAS single-decision guarantee — a double
decide (banner + card) produced exactly one `decide 200` and one loud
`decide 409` ("already been decided"), never a double execution. Present-mode
credential forwarding verified (host tools returned the signed-in user's real
accounts/payees; requires the operator-set VENDO_BASE_URL trust anchor by
design). The kept tool-search and capability-miss features both fired live.

Notes for follow-up (pre-existing, not Wave 2): the floating voice widget can
intercept clicks on the in-conversation approval card at short viewport
heights; deciding from the global pending-approvals banner does not resume the
originating thread (decide-without-resume).
