---
"@vendoai/vendo": patch
---

Init asks where the app runs in DEV, and stops asking where it deploys. The dev
origin is the one Vendo cannot learn: an own-loop tool call, a backend process
and the MCP door each make a real HTTP request back at the host's own API and
never see a wire request to read an origin off, so every one of those installs
met `Cannot execute … set VENDO_BASE_URL` on its first turn — after a run that
had reported itself finished. Interactive init now asks one question, prefilled
with the port the host's own `dev` script names, and writes the answer to
`.env.local` as `VENDO_BASE_URL`. Enter is the whole interaction, and the
terminal echoes the value it wrote rather than calling an accepted default a
skip.

A run that cannot ASK still writes nothing: the prefill is an answer only when a
person accepts it, and a guessed origin is worse than an absent one — unset, dev
learns the request's own origin and production fails loud, both unchanged.
`--base-url` is that same answer as a flag (dev origin, `.env.local`), and it
travels in `--agent` mode's question list like every other decision a person owns.

"Where will this deploy?" is gone, with the `.env.example` rewrite that went with
it. Production is told at deploy time, not asked at init: `.env.example`'s
`VENDO_BASE_URL` block is now an instruction — dev is already in `.env.local`, and
the real value goes in the hosting platform's own environment settings, never in a
committed file and never in `.env.local`, where a public URL would repoint local
dev's discovery, callbacks and credential forwarding at the deployed origin. The
MCP arm reads the dev answer for the client URL it prints, so the address a user
pastes into Claude is the app they are actually running, and its first step now
points at deploy time for the public one.

No platform variable is ever consulted: nothing infers an origin from `VERCEL_URL`
or any sibling. The URL is set by the person who knows it, or it is loudly unset.
