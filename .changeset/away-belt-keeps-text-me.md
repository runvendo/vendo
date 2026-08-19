---
"@vendoai/vendo": patch
---

An away run keeps the powers the person granted it. Live 2026-08-19 on
production Maple, the day after the arming fix: "check my balance and text me"
was armed with all 33 standing grants, fired on time, read the balance — and
then told the customer "I don't have a way to send a text message." The grant
was real; the tool was not on the belt.

Two mechanisms, one silence. The starting toolbelt is cut safest-first at 24
tools, and Maple's away surface is 25 reads and 6 writes, so every WRITE was
evicted — `vendo_text_me` with them. Everything past the belt is meant to be one
`find_tools` search away, but the away and delegated briefs hardcoded
`discovery: false` on the belief that an away run carries no discovery rails.
It was never true: an away run thinks on the SAME composed `vendo()` a chat turn
does, `find_tools` is one of that brain's own hands, and the model was simply
never told it was holding one.

Both halves are closed. `vendo_text_me` joins the always-active set, so a
granted way to reach the person is never what the cap displaces — the first
honoring of a contract the `loadout` docs have stated since ENG-252 ("Vendo's
own `vendo_*` tools are always active") and nothing implemented; the rest of it
waits for the loadout redesign. And the discovery rail is DERIVED from the
harness that actually runs, in one place every path now shares, instead of being
written four times with three of them hardcoded off — an uncurated surface is
still told about nothing, because it still has nothing.

The demo bank raises its own belt to 64 alongside this. The 24 default is sized
for a 600-tool catalog; Maple's whole surface is ~31 tools, inside the 30-50
band where selection accuracy is best, and the default's safest-first cut is
what buried its writes twice in two days.
