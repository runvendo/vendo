# ENG-309 verification — persist failure after completed stream (AGENT-8)

Bug: `packages/agent/src/agent.ts` persisted the finished turn in `onFinish`
with no try/catch and no retry. A store write failure after the SSE `[DONE]`
lost the thread while the user saw a successful response — and the raw
injected error escaped through the stream transport.

Evidence (agent test suite `packages/agent/src/threads.test.ts`, describe
"persist failure after a completed stream (ENG-309 / AGENT-8)"):

- `01-red-unfixed.txt` — the two new tests run against the UNFIXED
  `agent.ts` (persist call restored to the bare
  `await threads.persist(...)`): both fail. The stack shows the injected
  store error escaping from `onFinish` via `ThreadRepository.persist`,
  i.e. the exact silent-loss / stream-corruption path.
- `02-green-fixed.txt` — same tests with the fix (`persistFinishedTurn`:
  bounded retry 3 attempts with 100ms/500ms backoff, then a loud structured
  `console.error` naming the thread): 8/8 pass, including the six
  pre-existing thread tests.

Wire-signal decision: by the time `onFinish` runs, the response headers and
the SSE `[DONE]` are already delivered, so no additive wire signal can reach
this turn's client. Per the locked direction, the fix is bounded retry plus a
loud structured error path (never throwing — a throw corrupts the
already-delivered stream, which is what the red run demonstrates).
