---
"@vendoai/core": patch
"@vendoai/apps": patch
---

Advisory compile issues are advisory at every validation door.

#906 put ONE floor behind the four doors an app reaches a screen through, but the
compile issues in FRONT of that floor were still classified twice. The paint seam
refuses only what did not parse — `compile-failed`, `missing-app` — while
`validateCompiledCreate` turned EVERY wire issue into a block.

They disagreed on `wire-id-ignored`, which is not a code a model has to invent:
`checkoutApp` writes an app's own `app.vendo` with
`printWire(…, { includeIds: true })`, so every element of a checked-out app carries
an id the compiler then ignores. The seam painted those bytes and
`validate({ document })` refused them — the door the assembly loop is told to call
"the floor" answering "does not pass" over our own printer's output. PR #913
measured it and deliberately left it.

Core now names the one classification the doors share
(`isAdvisoryWireIssue` / `WIRE_ADVISORY_ISSUE_CODES`), and the create and edit
validators read it instead of blocking on every issue. Nothing else moves: an
issue that drops something the author actually wrote still blocks everywhere, and
the paint seam's own parse gate is untouched.
