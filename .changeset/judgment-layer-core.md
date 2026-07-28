---
"@vendoai/actions": minor
---

Add the judgment layer's core: `.vendo/judgments.json` and the direction rule.
Remove the `watermark` and `enriched` fields and the restrictive-only clamp they
served.

`.vendo/` gains a THIRD file, split from the other two by author the same way
`overrides.json` is: `vendo/judgments@1` (`judgmentsFileSchema`,
`JudgmentsFile`, `ToolJudgment`, `JudgmentFields`, `PendingLoosening`) is where
the model writes. Every entry costs a quoted piece of handler evidence —
`evidence` is required and length-bounded at both levels, and a malformed file
fails loudly at parse rather than being ignored, because it can carry disables.

The new `@vendoai/actions` root exports replace the old clamp:

- `classifyField(tool, field, value)` — "harden" or "loosen". Risk up, audience
  narrowed, `disabled: true`, `critical: true` harden; the inverses loosen.
  Prose and semantics route with the hardenings.
- `splitProposal(tool, proposal)` — hardenings apply; loosenings are QUEUED as
  `pending` with their own evidence instead of being refused and forgotten, and
  wait for a human. Direction is computed against the tool's effective state
  (skeleton ⊕ the standing judgment), so judgments only ever ratchet tighter.
- `applyJudgment(tool, judgment)` — inert when the judgment's `binding` no
  longer matches the tool's identity, so a stale judgment never grades another
  handler. Semantics merge per key; `pending` is never applied; an
  operator/internal audience still composes `disabled: true` (fail-closed).
- `pruneJudgments(file, tools)`, `RISK_RANK`, `AUDIENCE_RANK`.
- `bindingIdentity` / `dedupKey` now also ship from the package root (pure, no
  node imports) — writing a judgment means computing a binding identity, and
  the runtime side cannot reach the node-only `./sync` entry.

Removed: `clampEnrichment`, `applyEnrichmentFields`, `carryEnrichment`,
`gitTreeHash`, `EnrichmentFields`, `ClampedEnrichment`, and `RISK_RANK` /
`AUDIENCE_RANK` from `@vendoai/actions/sync` (the ranks moved to the root).
Removed fields: `ToolsFile.watermark`, `ExtractedTool.enriched`, and the
`watermark` option on `vendoSync`. The per-tool `semantics` carry across
structural syncs is unchanged, and so is `ExtractedTool.outputSchema` — a
declared response shape is not a judgment, and it is load-bearing for
first-try prop binding (docs/verification/demo-live-readiness/donut-bind).
