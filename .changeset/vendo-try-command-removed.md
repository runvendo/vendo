---
"@vendoai/vendo": major
---

**BREAKING:** the hidden `vendo try` CLI command is removed, along with the
local try server and the pipeline that fed it (`cli/try.ts`, `cli/try/server.ts`,
`cli/try/extract.ts`, `cli/try/deepen.ts`) and the retired refine engine
(`src/refine.ts`) whose only remaining caller was that server. `vendo try` now
falls through to the unknown-command error like any other unrecognized command.

The command was already unlisted (help never named it — the pre-install
`npx vendo try` pitch it fronted resolves no npm package), and the hosted try
venue replaced its job: vendo.run/playground mounts the same surface against
the console's profile/seeds/chat endpoints.

Everything the hosted venue and the docs pipeline stand on is untouched:
`@vendoai/vendo/try-surface` (the client surface, including the try-mode
components), `@vendoai/vendo/try` (the try artifact schemas and
`createSyntheticFetch`), and `startPlaygroundServer` with the playground
bundle it serves.
