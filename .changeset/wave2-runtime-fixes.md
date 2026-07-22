---
"@vendoai/vendo": patch
"@vendoai/apps": patch
"@vendoai/ui": patch
---

Wave 2 runtime fixes from the 0.4.x E2E certification campaign:

- Mastra shim: open-schema guarded tools (extracted routes whose body shape
  is untyped) no longer execute with `{}` when the user dictated args.
  Mastra's provider schema-compat layers hard-close every object schema for
  strict-mode providers, so an open input reached the model as "takes no
  arguments"; the shim now bridges open inputs through one declared `args`
  property (JSON object or JSON-encoded string) and unwraps it before the
  guard, so approvals park — and replay — with the real arguments.
- Failed app builds now carry their reason everywhere: `create()` re-throws
  with the classified reason in the message (the tool outcome the calling
  agent reads), logs the un-canned issue list to the operator terminal
  (previously a silent failure), and the app embed shows a retry hint for
  retryable failures. The generation engine now captures streamText's
  swallowed provider errors, so quota/timeout/no-key failures classify
  correctly instead of collapsing to "generation failed".
- The dev model's no-usable-credential lines (missing provider package, no
  key at all) surface verbatim in the failed-build reason — the in-surface
  error now carries the actionable `npm install @ai-sdk/...` / `vendo login`
  instruction instead of `model could not produce a valid app`.
- `@vendoai/ui` DonutChart no longer crashes on `undefined`/non-array data
  inside generated apps; it renders the designed empty state like the other
  Kit charts.
