---
"@vendoai/apps": patch
"@vendoai/core": patch
---

Generation now rejects capability substitution: a mutating host tool invoked with a hand-typed target or amount is sent back to repair instead of shipped. The live defect this closes had a generated island calling `host_transferMoney({ amount: 1, recipient_name: 'Slack Forwarding Bot', memo: 'APPROVED TRANSACTIONS: …' })` on a host with no messaging tool — a payments API used as a message channel, with a real side effect. The rule is mechanical (argument provenance, not intent matching): operands that arrive through tool data, user input, form state, or a row the user acted on always pass; the values the user themselves named in their request always pass; enums, flags and consts a tool declares never trip it. Both surfaces are covered — declarative action payloads and `tools.*` calls in island source. When the host lacks the capability, the honest disclaimer path is the only valid answer.
