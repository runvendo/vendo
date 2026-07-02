# ENG-202 findings — host API as the agent's tools (embedded half)

**Date:** 2026-07-02 · **Branch:** `yousef/eng-202-their-apiclimcp-as-the-agents-tools-act-as-the-user`

## What shipped

The embedded half of ENG-202 per the locked architecture (Decisions 2 and 4): an OpenAPI-to-tool adapter and browser call executor in `@flowlet/core`, a client-executed tool path through the agent's caller seam in `@flowlet/agent`, a browser-side runner and host-aware resubmit predicate in `@flowlet/react`, and demo-bank as the testbed with a real OpenAPI spec (16 reads + the `createOrder` write). Verified live: reads run without cards, the order write pauses on the existing approval card, executes **from the browser** on the user's session (`POST /api/orders` visible in the browser network log, transaction lands in the store), and a decline never executes. Evidence in `assets/eng-202/`.

## SDK semantics discovered (ai 6.0.28, probed empirically)

These drove the design and matter for the cloud port (ENG-198):

1. **The tool call streams before its approval request.** `tool-input-available` (which fires `onToolCall`) is emitted before `tool-approval-request` in the same stream. A client executor keyed off `onToolCall` would execute gated calls before the user ever sees the card. The runner therefore keys off *settled* tool-part state (stream finished, or approval answered).
2. **An approved client tool must get its output client-side before resubmitting.** The SDK's stock `lastAssistantMessageIsCompleteWithApprovalResponses` fires as soon as approvals are answered; for a no-execute tool that resubmits a broken prompt (empty tool message). Hence the host-aware `sendAutomaticallyWhen` that holds resubmission until approved host tools carry outputs. The server skips approved calls that already have results — this is the SDK's designed client-tool approval path.
3. **Declines need no code.** The SDK synthesizes an `execution-denied` tool result from a declined approval; the model sees it and responds accordingly.
4. **Policy `deny` on a client-executed tool cannot be short-circuited server-side** — there is no `execute` to intercept. `wrapClientTool` fails closed by throwing in `needsApproval`, which errors the turn (an error part in the thread). Unreachable today (the annotation policy yields only allow/approve), but the cloud runtime should keep this in mind if deny-capable layers (principal rules, NL judge) are enabled for host tools. Residual trust model: the browser executor belongs to the user whose credentials authorize the call, so client-side enforcement guards the *agent*; the host API remains the real boundary for the user.

## Notes for the cloud port (track A merge)

- The embedded demo passes definitions through `RunInput.tools` (the caller seam, now exercised for the first time). On the cloud session the same `hostToolset(defs)` output binds from the published manifest (`tools.json`, ENG-197) instead of a local spec file — nothing else in the chain changes.
- The SDK-side runner (`hostTools` on `FlowletProvider`) is transport-agnostic; it already works over HTTP transports, so it ports to the cloud SSE session unchanged.
- The adapter doesn't resolve `$ref` yet — specs must inline schemas (demo-bank's does). Fine for the extractor to guarantee later.

## Known quirks / debt (not fixed here, out of scope)

- **Duplicate activity chips:** after a client-tool round-trip, the thread shows the tool chip twice (the continuation turn re-renders the tool part in a second assistant message). Cosmetic; pre-existing rendering behavior in `use-flowlet-thread` grouping, also affects approved Composio tools.
- **`pnpm lint` fails on a clean tree** in demo-bank — the generated `public/flowlet/components-sandbox.js` bundle trips `react-hooks/rules-of-hooks`. Pre-existing; lint should ignore `public/`.
- demo-bank still carries the in-process `get_transactions` demo tool alongside the host-API `listTransactions`; both work (names don't collide). Retiring the demo tool is a later cleanup.
