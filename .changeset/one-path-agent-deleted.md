---
"@vendoai/vendo": major
"@vendoai/harnesses": major
---

Delete `@vendoai/agent`: one engine, one path, one home.

The old `createAgent()` chat engine survived for one reason — hosted-store
deployments could not serve harness turns, so they silently fell back to it.
They can now, so the legacy path, its runner and `agent.stream` are gone and the
harness runtime serves every turn. Nothing a client can see changes; the
wire-parity suite is the proof.

Breaking changes:

- @vendoai/agent (whole package) → harnesses (runtime/loop/rails) + vendo
  (pack/prompt/threads)
- createAgent/AgentConfig → createVendo harness path
- VendoAgent type → none; HarnessTurns is the surface. Vendo.agent property →
  Vendo.harness
- asRunner()/createRunner → awayRunner (composed internally for vendo_delegate)
- supervise hook → dropped
- memory-store fallback in the turn door → loud per-turn refusal
  (memoryStoreAdapter itself stays in core/conformance)
- WireDeps.agent → WireDeps.harness (required)
- Thread/ThreadSummary, tokenBudgetStop, ScriptedTurn, pack consts → new import
  homes (@vendoai/vendo, @vendoai/harnesses)
- Behavior: vendo_delegate persists a thread + workspace per delegation (was
  stateless)
- Behavior: POST /threads on a no-SQL/no-ops store → loud not-implemented error

Also fixed on the way out: a failed turn whose harness threw (rather than
reporting an `error` event) answered with one generic constant, so a keyless
deployment was told "something went wrong" instead of to run `vendo login`, and
nothing was persisted. Both runtime paths now pass the error through the same
`wireErrorMessage` gate the legacy door used, and raise the same two carriers —
the error chunk and the persisted `data-vendo-turn-error` part.
