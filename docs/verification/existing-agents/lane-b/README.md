# Existing-agents Lane B — browser evidence

Embeds rendered inside a PLAIN non-Vendo chat page (own markup, Georgia serif,
no Vendo chrome) against a real `createVendo` wire: guarded host tool
(`host_sendTripReport`, ask-on-write policy), a real imported app, and parked
BYO approvals via `vendo.guardedTools`. Captured 2026-07-20 with Playwright
against a local harness (throwaway, not committed).

- `lane-b-01-initial-full.png` — the full chat: ready `VendoAppEmbed` (live
  tree app), building `VendoAppEmbed` (build-beat bar + skeleton, app not yet
  servable), approval embeds, and plain tool data rendering NO embed.
  Captured after the 15s demo TTL had already swept the two pending cards —
  so all three approval embeds show `expired`.
- `lane-b-02-ttl-expired-in-place.png` — same page moments later: the
  pending consent cards resolved IN PLACE to "Expired — no longer waiting
  for approval" via the embed's poll when the parked-call TTL sweep denied
  them (no reload, no silent blank).
- `lane-b-03-approved-and-declined.png` — after clicking Approve on the
  first card and Deny on the second (TTL raised to 180s): "Approved — ran"
  with the executed result (`{"to":"client@example.com","delivered":true}` —
  the parked call actually executed on approve), "Declined — nothing ran",
  and a still-pending consent card with real inputs + Approve/Deny +
  Remember disclosure.
- `lane-b-04-themed-accent.png` — the same page loaded with a host theme
  override (`accent #4739e6`, tighter radii) via `VendoProvider theme` —
  the embeds re-skin through the `--vendo-*` tokens (buttons, stat borders,
  bar dots) while the host page's own styling is untouched.
