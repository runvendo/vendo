---
"@vendoai/vendo": patch
---

Every text this channel sends now says whether it is the last one. A reply the
model splits at a divider goes out in pieces, and until now each piece looked
exactly like a whole answer on the wire — so the far side could only guess
whether to keep the typing indicator up or take it down, and it guessed wrong in
both directions: dropped between "On it." and the answer, or left spinning after
the last word.

`ChannelsService.send` takes an optional `final`, and the Cloud adapter passes it
straight through to `/api/v1/channels/text/send`. Optional on purpose — a host
carrying its own texts keeps the implementation it already wrote, and a carrier
with nothing to do with the flag ignores it.

The flag scopes to one MESSAGE, never to the turn. It says "no more of this text
is coming", not "nothing else will arrive" — nothing could say the second one,
because `vendo_text_me` and an automation firing reach the same conversation at
any moment, and a turn's own grant-set question is decided from the live approval
feed only after the reply has gone out. A receiver reads it to stop showing a
reply as still-being-written, never as "stop listening".

The value is decided by what each send truthfully is, never by position. Only
`streamTexts` has a mid-reply cut to declare, and it reads finality off the
stream rather than off the divider: the segment goes out the moment its divider
passes, and what comes next may be a tool call that takes three seconds or
nothing at all, so the end of the stream is what settles it. That is also what
marks the last text of a reply signed off with a divider — that cut is only
recognized once the stream has ended. Everything else is one whole message with
nothing behind it: an approval card and a grant-set ask are questions the
conversation then waits on, the set receipts and the "you're linked" ack end
their exchange, and a `vendo_text_me` push has no stream behind it at all.
