# @vendoai/agent

Runs Vendo's streaming, tool-calling conversation loop against any AI SDK
`LanguageModel`, with persisted threads and guard-bound tools.

Threads persist through the composed store; without a store the agent keeps
per-subject threads in process memory. `agent.evictSubject(subject)` drops that
in-memory state when an ephemeral session is evicted — the umbrella calls it
for every subject the store's idle sweep returns (store-backed ephemeral
threads live in the store's overlay and are cascaded there).

`stream({ signal })` cancels a turn: the in-flight provider call aborts, no
further step starts, and the thread stays consistent and resumable (the
umbrella passes the request's own signal, so client disconnect cancels the
loop). The per-turn step cap is `context.maxSteps` (default 20); exhausting it
streams a renderable `data-vendo-step-limit` part instead of ending silently.

Approvals a conversation walks away from resolve guard-side: a fresh user turn
marks undecided asks abandoned in the thread and denies them through
`guard.abandonApprovals` when the guard provides it. Client upserts are
validated — a new message must be user-role, and an existing assistant message
may change only by answering a pending approval.

Read [Prompts](https://docs.vendo.run/concepts/prompts) and the
[architecture overview](https://docs.vendo.run/concepts/architecture).
