# @vendoai-fixtures/test-kit

Test helpers that MORE THAN ONE suite needs, and that a suite could not write
differently without being wrong. Private: a devDependency of the suites that use
it, never published, never a runtime dependency of anything.

## What belongs here

Only helpers for the two counterparties a test genuinely cannot run:

- `./stream-turns` — the scripted `LanguageModel` and the stream parts it
  replays. The counterparty is Anthropic's API.
- `./node-bridge` — a `node:http` request/response pair handed to a Web
  `Request` → `Response` handler. Not a double at all: it is the same adapter a
  Node host writes for real, so a fixture serving the umbrella's own `handler`
  over a loopback socket is exercising the real handler over real HTTP.

## What does not

A helper that stands in for something this repo owns. A harness that mocks the
counterparty proves nothing (CLAUDE.md), and a *shared* one hides the
disagreement from both sides at once. Anything spanning a producer and a
consumer in this repo has a real write path and a real read path; drive those.

Concretely, these were considered and left where they are:

- **the guard double** (`packages/harnesses/src/test-doubles.test-util.ts`,
  `packages/vendo/src/agent-doubles.test-util.ts`) — `@vendoai/guard` ships a
  real `createGuard`, and `packages/guard/test/abandon.test.ts` already drives
  it against a real store. A shared `testGuard` would be a fake standing in for
  a seam that can be run for real, promoted to a package.
- **`tempStore`** — forty copies, every one of them inside `packages/vendo`.
  That is one package's own helper written forty times, not a shared one.
- **`packages/harnesses`' turn helpers** — same NAMES, different meaning. This
  kit's `textTurn(text, id)` names the stream part; harnesses'
  `textTurn(text, usage)` sets the token usage on the `finish` part and
  hardcodes the part id. Seven of its 73 call sites pass the second argument and
  every one passes a usage object, all of them feeding the metering asserts
  (`vendo/ledger.test.ts`, `vendo/subagent-loop.test.ts`, `vendo/vendo.test.ts`).
  Reading that argument as an id would zero every usage figure and leave those
  suites asserting against `ZERO_USAGE` — green, and measuring nothing. Its
  `scriptedModel` is a different double too: `doStream` only, recording
  `toolNamesPerCall`/`systemPrompts`/`calls` rather than driving a generation
  engine. Only `ZERO_USAGE` and `toolCallTurn` are truly identical, and taking
  just those two would leave one file where `toolCallTurn` is this kit's and the
  same-named `textTurn` deliberately is not — the very collision that makes the
  74 call sites dangerous. Left whole, on purpose.

## No barrel

There is no `.` export on purpose. `./stream-turns` needs `ai`; `./node-bridge`
needs nothing. A barrel would make every consumer of either pay for both, and a
suite that has no model has no reason to install one.
