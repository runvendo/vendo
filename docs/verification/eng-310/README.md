# ENG-310 verification — lost-update race on concurrent turns (AGENT-9)

Bug: `packages/agent/src/threads.ts` `persist()` was a bare
`put({ id, data, refs })`. Two overlapping `stream()` calls on one threadId
each finish holding their OWN copy of the history, so last-write-wins
clobbered the other turn's messages. The guarded upsert in `resolve()` covers
cross-subject takeover only, not same-subject races.

Evidence:

- `01-red-unfixed.txt` — the two new concurrency tests
  (`packages/agent/src/threads.test.ts`, describe "concurrent turns on one
  thread (ENG-310 / AGENT-9)": two overlapping `stream()` calls via
  `Promise.all` on one threadId, fresh and existing thread) run against the
  UNFIXED `persist()`: both fail — one turn's user message and reply are
  gone after the race.
- `02-green-agent.txt` — same tests with the fix: 10/10 pass (including all
  pre-existing thread tests and the ENG-309 tests).
- `03-green-store-cas.txt` — the store-level guarded-write tests
  (`packages/store/src/thread-scoping.test.ts`, describe "vendo_threads
  guarded writes (ENG-310)"): routed `atomic.insertIfAbsent` admits exactly
  one concurrent first-persist, `compareAndSwap` admits exactly one
  concurrent swap per revision, foreign subjects can never land a guarded
  write, and the ephemeral overlay path behaves identically.

Mechanism (checked @vendoai/store's primitives first, as directed):

- The FROZEN contract (01 §12) already reserves the optional
  `RecordStore.atomic` capability (`insertIfAbsent` + `compareAndSwap` over an
  opaque `revision` token). The generic record path and the conformance
  memory adapter implement it; the routed reserved `vendo_threads` door did
  not — so this change ADDITIVELY implements it there, backed by a new
  `revision bigint NOT NULL DEFAULT 1` column (same `ADD COLUMN IF NOT
  EXISTS` migration pattern as the thread `title` column).
- `persist()` is now read-merge-guarded-write with bounded retry (5
  attempts): re-read the current row, merge this turn's messages into the
  CURRENT history (upsert by message id — same identity rule as the
  in-stream upsert), then `insertIfAbsent` (first turn) or `compareAndSwap`
  on the freshly-read revision. A loser re-reads and re-merges; exhaustion
  throws a structured conflict which ENG-309's retry/loud-error path
  surfaces.
- Adapters without `atomic` fall back to the merged put — still a huge
  improvement (the race window shrinks from a whole streaming turn to one
  read-write), and the door's subject guard keeps refusing takeovers.
- Memory mode merges synchronously against the current map entry (atomic in
  JS), so it needs no further guard.

Note: queue-send (ENG-215, separate lane) reduces but does not eliminate
concurrency — two tabs on one thread remain possible, which is exactly the
overlapping-turns case these tests pin.
