---
"@vendoai/vendo": patch
---

Six mechanical install-DX fixes from a live run of the published CLI. A
generated `@/lib/vendo` import is a path alias, not the npm package `@/lib`, so
init no longer writes `"lib": "link:@/lib"` into your package.json and your next
`npm install` no longer dies on EUNSUPPORTEDPROTOCOL. The predev impact probe
knocks on the port init wrote to `.env.local` as `VENDO_BASE_URL` instead of
assuming 3000, so `pnpm dev` on any other port stops reporting "impact unknown".
`vendo login` keeps its machine-readable JSON receipt off a terminal a human is
watching, and its one-line pretty ceremony now names the approval URL up front —
the browser open is best-effort, and a headless box was left with a code and
nowhere to type it. Every rail row is cleared to end of line, so a select redraw
can no longer leave a longer line's tail behind. A failed AI brief polish says
the install is complete and valid with the default brief and names
`vendo sync --ai`, instead of printing a raw JSON parser error. And the detected
stack — framework, router, language, package manager, auth — is read back before
the first question on every run, not only the ones dressed in the rail.
