# @vendoai/agent

Runs Vendo's streaming, tool-calling conversation loop against any AI SDK
`LanguageModel`, with persisted threads and guard-bound tools.

Threads persist through the composed store; without a store the agent keeps
per-subject threads in process memory. `agent.evictSubject(subject)` drops that
in-memory state when an ephemeral session is evicted — the umbrella calls it
for every subject the store's idle sweep returns (store-backed ephemeral
threads live in the store's overlay and are cascaded there).

Read [Prompts](https://docs.vendo.run/concepts/prompts) and the
[architecture overview](https://docs.vendo.run/concepts/architecture).
