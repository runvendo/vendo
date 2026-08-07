---
"@vendoai/apps": patch
---

Delete the orphaned edit validator, and make `one-floor.test.ts` true again.

`documentFromEdit`, `validateEditedApp` and their `issueLine` helper lost their
only caller when "the brain dies" deleted `generation/conductor.ts`: an edit is
the screen assembler rewriting the app's own `app.vendo` and saving it, so it is
checked by the paint seam's floor and by nothing else. Nothing public changes —
none of the three was exported from the package.

`one-floor.test.ts` opened by claiming four doors "each through its own REAL
entry point" and then drove its edit case through that orphan, so its edit-door
proofs were proofs about a function nothing calls. It now drives three doors
through `AppsRuntime.floor(ctx)`, `validate({ document })` and
`validate({ appId })`, and says plainly that the edit path is the first of them.

With the orphan goes its **carried-issue filter** — an edit was excused for an
issue the previous version already carried. That rule was never re-implemented
on this architecture and is not a behaviour production has: the floor runs on
every commit for every author, and a block is a block.
