---
"@vendoai/store": minor
"@vendoai/vendo": minor
---

The store warns when it is writing to disk the platform wipes, and `vendo doctor`
finds the same thing statically as `E-STORE-001`.

Railway, Render, Fly.io and Heroku all run a long-lived process, so PGlite
genuinely works there and refusing outright would be wrong — but they replace the
container filesystem on every redeploy. The store kept working and quietly lost
every app the host's users had built at the next deploy, with nothing said at any
point. It now says so at construction, naming the directory it is about to write
to and both ways out: mount a persistent volume and point `dataDir` at it, or
pass a Postgres `url`.

A platform marker is evidence on its own, so the warning does not wait for data
to appear — warning before the first user writes is the whole point. A path under
`/tmp` warns without a marker. `memory://` and a configured Postgres `url` say
nothing, and the existing hard refusal on genuinely serverless environments
(Vercel, Cloudflare Pages, Lambda) is untouched and still throws, because there
PGlite cannot work at all.

`vendo doctor` carries the static twin as `E-STORE-001`, so the wipe is findable
before a deploy rather than after one. A project under `/tmp` additionally needs
a real database sitting there: a scratch checkout under `/tmp` is what doctor
sees on a laptop, and a false warning on every local run is worse than no
warning. The check also stays quiet when `VENDO_API_KEY` composes the hosted
store, since the local data directory is then one that nothing ever writes to.
