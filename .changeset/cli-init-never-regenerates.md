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
framed block as the layout mount (naming the file and the exact lines or diff),
carries it in `--agent` as an `edits[]` array of `{file, lines, why}` alongside
`mount`, and lists it in `manualSteps` and the agent tail.

**`vendo doctor` catches what you skip.** New `E-WIRE-009`: the host has
`"use server"` actions, but the registration map is missing entries or the route
never passes `serverActions` to `createVendo`. Nothing else went red for that
before — the tools simply failed closed at execution time.

`package.json` hooks are unchanged: that is Vendo-owned config, not your source.
