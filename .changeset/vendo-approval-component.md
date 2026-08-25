---
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

`<VendoApproval>` — the outside-agent approval as one element.

An agent that lives outside your product parks a guarded call and ships the ask
to your page. This renders it on the same card the in-product agent asks on
(spec §16 — one shell everywhere), decides it against your wire, and settles
into its own receipt. Two props: the `approval` block off the parked outcome
(`{ id, question, notes }` — the words are already chosen, because such an agent
never holds the `ApprovalRequest` they are derived from) and the `VendoClient`
the decision is spent on.

An ask that is no longer waiting — already answered on another surface, or
expired — settles into that same receipt rather than leaving buttons up that
cannot work.
