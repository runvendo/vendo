---
"@vendoai/vendo": minor
---

`vendo init` now ALWAYS asks "How do your users sign in?" — Auth.js / Clerk / Supabase / Auth0 / JWT / write my own / none yet. The package.json scan moves the CURSOR instead of deciding: one unambiguous family is pre-selected so Enter still wires it, and the hosts the scan cannot read (several auth dependencies, or none at all) now get the same question instead of an anonymous composition nobody chose. Runs nobody is watching — `--no-input`, no TTY, CI, `--yes`, `--agent` — take that same pre-selected answer silently, exactly as before; a question never hangs an unattended install.

Two answers are new. **JWT** is a real choice now rather than a printed recipe: it already satisfied the runtime (`jwt()` composes through the same `composeHostAuthPreset` the vendor presets do, oauth half included) and the only thing in its way was that it cannot be zero-argument, so init supplies the argument — `auth: jwt({ secret: () => process.env.HOST_API_JWT_SECRET })` in the composition, and the matching `.env.local` entry for you to paste your API's signing secret into (an existing value is never overwritten). **Write my own** scaffolds a working minimal seam — a fixed dev subject and a pass-through door principal — marked `// replace before production` with a link to the seam docs.

`vendo init --use-case mcp` with "none yet" is now an expected FAILURE (exit 1) instead of a warning over an exit-0 "Wired": nothing is written at all, and the message says what happened, why the door cannot open, how to answer, and carries the seam the "write my own" answer would have scaffolded. Because nothing lands, re-running with a real answer now works — the old refusal wrote the anonymous composition anyway, and init never rewrites a composition it already wrote. The claim that `jwt()` does not carry the oauth half is removed wherever it appeared; it does, and so does a hand-written seam, so a re-run over either is no longer refused.

`--auth` gains `custom` (`authJs | clerk | supabase | auth0 | jwt | custom | none`).
