---
"@vendoai/agents": patch
"@vendoai/guard": patch
"@vendoai/core": patch
---

An approval now reaches ONLY the conversation that parked it.

Every `agent().session()` subscribed to the shared guard's
`onApprovalRequested` unscoped, so a guarded action parked in one
conversation surfaced in every other session's `on("approval")` handler —
another user's pending action, preview included, with live approve/deny
closures. The subscription was also never released, so a dead session's
callback outlived it on the guard.

The guard has always recorded the parking conversation
(`ApprovalRecordData.sessionId`, from `RunContext.sessionId`); that identity
now rides the emitted request too (`ApprovalRequest.ctx.sessionId`, optional
only for rows persisted before it existed). Sessions deliver a request to
their handlers only when it names their own thread — an ownerless request
matches none, failing closed — and the guard subscription is taken on the
first `on()` handler and released with the last. Deciding an approval was
and remains owner-scoped: a foreign principal's decide is `not-found`.
