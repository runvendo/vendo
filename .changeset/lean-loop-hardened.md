---
"@vendoai/agent": minor
"@vendoai/harnesses": minor
"@vendoai/guard": patch
"@vendoai/vendo": patch
---

Harden the turn loop: one turn id everywhere, a token budget instead of a message
count, a stated retry budget with ordered failover, an extensible stop array, and
the supervisor slot.

Every part of this is the shipped loop doing more, not a second loop beside it.

- **Turn id on both routes.** `mintTurnId` had exactly one call site — the harness
  runtime — so a deployment whose store cannot serve harness turns (a host's own
  non-SQL adapter, the Cloud hosted store) wrote audit rows that named no turn.
  `createAgent` now mints on the same terms, onto the `RunContext` every guarded
  call and audit mint already holds. An id the caller already minted wins.
- **Token-budgeted compaction.** `context.contextTokenBudget` bounds the PROMPT
  rather than the message count, shedding reasoning, then old tool payloads, then
  the oldest messages — via `pruneMessages`, which drops a tool call together with
  its result so the prompt stays well-formed however much it sheds. The size is a
  documented chars/4 estimate; `historyWindow` is unchanged.
- **The knobs reach both thinkers.** `vendo()` built its context only when a
  `maxSteps` existed and put only `maxSteps` in it, so a host's `agent:` history
  window was silently ignored on the DEFAULT route. `VendoHarnessOptions` and
  `VendoHarnessDeps` now carry `historyWindow`, `contextTokenBudget` and
  `maxOutputTokens`, the whole context is passed, and `createVendo` forwards the
  host's `agent:` block to the harness it composes.
- **Retries and failover.** `context.maxRetries` is explicit against
  `DEFAULT_MAX_RETRIES` (the SDK's own value, so nothing changed but ownership).
  `fallbacks` takes the rungs below the primary model and is tried in order when a
  provider fails BEFORE producing output; once output streams there is no
  failover, because a mid-stream switch would emit a second answer on top of half
  a first one. Cancellation is the only thing classified, and the last rung's error
  is rethrown untouched, so the wire error gate is unchanged.
- **`stopWhen` is extensible.** `createAgent`'s `stopWhen` composes with the loop's
  own three conditions; `tokenBudgetStop(n)` is the shipped per-tenant ceiling and
  is exported publicly. Opt-in — unset, a turn runs exactly as it did.
- **Supervisor slot, shipped as a no-op.** `createAgent`'s `supervise` gets the
  turn id, the final answer and the `RunContext`, and a refusal travels the failure
  path a turn already has (`wireErrorMessage`, the same `error` chunk, the same
  recorded notice). Unset costs a turn nothing.
