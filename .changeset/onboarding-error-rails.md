---
"@vendoai/vendo": patch
"@vendoai/agent": patch
---

The two first-hour model failures now show their fix instead of a generic error.

A keyless app and a missing provider install already had exact instructions —
but the model ladder threw them as plain `Error`s, so the wire's safe-error gate
replaced them with "An error occurred while generating the response." in the
thread and "the turn returned an error frame" in `vendo doctor`. The honest
message only ever reached the server log. Both are `VendoError`s now, so the
existing rail carries them to the thread banner and doctor's live-turn line.

A rejected key (401) got the same generic line. The ladder knows which rung it
resolved, so it now says which key was refused and what to do: a Cloud key is
re-minted with `vendo login`, a BYO provider key is checked in `.env.local` —
neither is ever sent the other's next step. The provider's own error stays on
`cause`, so its request id still reaches the server log. A 401 the ladder cannot
attribute — a provider the host wired itself, or a tool's own HTTP failure —
keeps the generic line rather than guessing it was about the model key. A 401
carrying the Cloud meter refusal still renders the pricing sentence.

`npx vendo try` turns ride that same rail now: the surface is handed the
ladder's own model instead of the raw provider one, so a rejected key names the
rung it was rejected on there too. That lazy model also forwards the resolved
provider's `supportedUrls`, so a remote image or PDF the provider can ingest
natively is no longer downloaded first — which is what made such a turn fail
outright under restricted egress.
