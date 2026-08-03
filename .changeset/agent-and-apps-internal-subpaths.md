---
"@vendoai/agent": minor
"@vendoai/apps": minor
---

Lift the turn loop out of `createAgent`, and expose the cross-block seams behind
`/internal`.

`@vendoai/agent`'s inner loop is now its own module so a harness can DRIVE it
instead of reimplementing it. Behaviour is unchanged — the package's own test
suite is the specification for the lift and passes unmodified.

- `loop.ts` owns the `streamText` call: the step cap, `buildFailedStop`, the
  history window, the Anthropic cache breakpoints, the abandoned-approval
  provider rewrite, the tool-search loadout, and the step-limit notice.
- `wire-error.ts` owns `wireErrorMessage`, so a second caller raises the
  IDENTICAL failure affordance — banner, Retry, detail line, and the
  meter-exhausted sentence — rather than inventing a second error UX.
- `tools.ts`'s guarded-call path and approval preview are reachable as
  `guardedCall(descriptor, options)` and `previewApproval(descriptor, options,
  onAsk)`. Both are CURRIED so the ai-SDK still invokes the body directly: an
  extra microtask before an abort raised inside a tool changes whether a dangling
  `input-available` tool part reaches the transcript.

**Host-facing surfaces are unchanged.** Everything above ships behind
`@vendoai/agent/internal` and `@vendoai/apps/internal` — the idiom
`@vendoai/core/conformance` already sets. The only supported consumer is another
`@vendoai/*` block, so these stay free to change without a major bump:

- `@vendoai/agent/internal`: `startTurn`, `providerHistory`, `turnModelMessages`,
  `DEFAULT_MAX_STEPS`, `wireErrorMessage`, `guardedCall`, `previewApproval`,
  `addAgentTool`, `buildAgentTools`, `createToolSearchSession`,
  `assembleSystemPrompt`, `validateUpsert`, `abandonPendingApprovals`,
  `guardApprovalIds`.
- `@vendoai/apps/internal`: `assembleTree`, `stripServerAuthoritativeFields` —
  so the harness runtime's render seam emits the payload shape the shipped
  emitter emits instead of keeping a drifting copy.
