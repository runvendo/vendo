---
"@vendoai/vendo": major
---

The playground and the hosted try surface are gone, and with them two entry
points: **`@vendoai/vendo/try` and `@vendoai/vendo/try-surface` no longer
exist**. The exports map goes from thirteen subpaths to eleven.

`./try` published the hosted try venue's session-composition surface
(`createSyntheticFetch`, `usecasesFileSchema`, `fixturesFileSchema`,
`tryProfileSchema`, `assembleTryProfile`, `VENDO_USECASES_FORMAT`,
`VENDO_FIXTURES_FORMAT`). `./try-surface` published the scripted playground
shell that `vendo.run/playground` and the docs inline-embed IIFE
(`vendo.run/playground/embed.js`) both mounted — `mount`, `PlaygroundApp`,
`TryBootConfig`, `TryProfile`. Both venues are retired: **nothing is served at
`vendo.run/playground` any more**, and the docs embeds it fed are now static
images. There is no replacement — run `vendo init` in your own app instead.

Deleted with them: the seeds extraction pass (`runSeedsPass`), the synthetic
fetch, the try profile schemas, and the embed-bundle build script. The
`vendo playground` command already printed a retirement notice and still does.

`createVendo`'s `profileDir`, `fetch`, and `profile` options are **unchanged** —
they are general composition seams and only their docs mentioned the dead
`vendo try` command.
