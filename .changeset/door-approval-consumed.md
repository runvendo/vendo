---
"@vendoai/guard": patch
"@vendoai/vendo": patch
"@vendoai/ui": patch
---

An approval card for a call parked at the MCP door no longer reads "expired" on
the approval the person just granted.

The door parks through the plain guard-bound registry, so — unlike the in-process
tool pack — nothing records a parked call and nothing resumes one: approving
GRANTS the call, and the outside agent's own retry runs it, exactly as the door's
refusal sentence says ("resolve it there, then retry"). `GET /approvals/:id` knew
only about the two lanes that DO leave a record, so the moment a door approval
left the guard's pending queue every read fell through to not-found — which
`<VendoApprovalEmbed>` renders as "Expired — no longer waiting for approval",
in red, on a call that was about to run and then did. Deny and the TTL sweep hit
the same hole; all three answered "expired".

The wire now falls back to the guard's own row for an approval no lane recorded,
so the status it reports tells the four cases apart at the server rather than
leaving the card to guess:

- approved, and the retry has spent it — `executed`, the card's "Approved — ran"
- approved, not spent yet — `pending`, so the card holds its working beat and its
  poll through the gap instead of settling on a receipt for something that has
  not happened
- denied by a person — `declined`
- denied by the TTL sweep, or a yes taken back — `expired` / `declined`

`VendoGuard.approvals.get` reports the three markers this needs beside the status
(`consumedAt`, `voidedAt`, `deniedBy`), each optional so an implementation that
returns only the original two fields still satisfies it. `outcome` is now optional
on the `executed` resolution: nothing server-side ran a door-parked call, so its
receipt can honestly say that it ran and nothing more.
