---
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

`<VendoApproval>` — the outside-agent approval as one element.

An agent that lives outside your product parks a guarded call and ships the ask
to your page. This renders it on THE card the in-product agent asks on — the
shipped `<ApprovalCard>` itself, not a lookalike built from the same shell (spec
§16 — one consent surface everywhere) — decides it against your wire, and
settles into its own receipt. Two props: the `approval` block off the parked
outcome (`{ id, question, notes }` — the words are already chosen, because such
an agent never holds the `ApprovalRequest` they are derived from) and the
`VendoClient` the decision is spent on.

`ApprovalCardProps` gains an optional `ask` for exactly that case: the ask
already in words, which skips the `consentAsk` derivation instead of asking a
surface with no request to fake one. Absent, the card derives as it always has.

An ask that is no longer waiting — already answered on another surface, or
expired — settles into that same receipt rather than leaving buttons up that
cannot work.
