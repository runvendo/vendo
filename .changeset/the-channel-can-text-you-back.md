---
"@vendoai/vendo": minor
"@vendoai/core": patch
---

The channel can text you first, and it stops talking itself out of the job.

One sentence of hidden grounding rode on every inbound text: "you cannot send
scheduled, recurring or unprompted texts, and you cannot set any of that up from
here — say so plainly if asked, point to the app, and say it is coming soon." It
was written about delivery. Next to a user's actual ask it read as a
channel-wide restriction, and on 2026-08-18 the agent refused four separate
transfer requests over text — "isn't something I'm able to do from here… do that
directly in the Maple app" — without ever searching its tool catalog, on a
prompt carrying three copies of the search-first instruction. The web surface,
which has no such note, moves the same money without a blink. The note itself
taught the refusal. It was also false about automations, which a texted user can
set up perfectly well.

The channel now states the one limit it actually has, and names the way around
it: "To text the user later, set up an automation for it — the Text me action is
how an automation reaches this phone, and its grant is part of arming. You cannot
otherwise send scheduled, recurring or unprompted texts. That is this channel's
only limit: anything else your tools can do, you can do right here in this
conversation."

That last clause is only true because the action it points at now exists.
`vendo_text_me` sends one text to the person the run is FOR, from any surface — a
web chat, an app, an automation firing at 6am while they are asleep. It composes
exactly when the text channel does, so a deployment that never asked for texts
is not offered a tool whose every call could only refuse.

Its input is `{ text }` and nothing else. There is no number to pass, so no model
output can aim a text at a phone that is not the current user's own: the
destination is read from that subject's link row, which only exists because the
signed-in user asked for a code and texted it back. Consent is the machinery that
was already there — a `write` descriptor on the one registry, so a live turn
parks whatever card the host's policy calls for, and an away firing needs the
standing grant that arming mints. "Text me when the rent clears" is allowed once,
on the screen where it is armed, and delivered from then on.

Nothing is claimed that did not happen. A user with no phone linked gets a
result carrying the connect link itself, minted fresh, so the agent can offer it
instead of apologising; a phone the router can no longer reach gets a result that
says the text did not go through and that reconnecting will fix it. The link row
remembers the conversation the person's own messages arrive on, which is the only
address the channel has — the deployment never learns the router's addressing,
and never sends to a bare number.
