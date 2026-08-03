---
"@vendoai/vendo": minor
---

`vendo init` only ever creates files in your source tree.

**The last two rewrites are gone.** Init used to regenerate
`app/api/vendo/[...vendo]/vendo-actions.ts` whenever the detected `"use server"`
surface moved, and to wire `serverActions` into an existing
`app/api/vendo/[...vendo]/route.ts`. It still creates both — once, on the run
where they do not exist yet — but a file you already have is never written
again. When init finds a change it will not make, it prints it in the same
framed block as the layout mount (naming the file and the exact lines),
carries it in `--agent` as an `edits[]` array of `{file, lines, why}` alongside
`mount`, and lists it in `manualSteps` and the agent tail.

**The map is yours from creation on.** An existing registration map is compared
only by the keys it registers, never byte-for-byte, so your formatting, your
comments, your aliases and your own extra entries all survive — and a reworded
comment in a Vendo release can never nag every existing install. A missing
action prints just the entries to add, with aliases that continue your file's
own `actionN` numbering. A route that passes a `serverActions` map it composes
itself is left alone entirely, and no generated map is created beside it.

**`vendo doctor` catches what you skip.** New `E-WIRE-009`: the host has live
`"use server"` actions, but the registration map is missing entries or the route
never passes `serverActions` **inside** its `createVendo({ … })` call. Nothing
else went red for that before — the tools simply failed closed at execution
time. Init and doctor resolve the wiring, the required action set and the map's
completeness through the same shared helpers, so they cannot disagree; both
honor `.vendo/overrides.json` and judgments, because a disabled tool is one the
runtime never dispatches.

`package.json` hooks are unchanged: that is Vendo-owned config, not your source.
