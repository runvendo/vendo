---
"@vendoai/vendo": patch
---

Three things a texted reply used to wait for, and now does not.

The host's memberships seam was asked FIRST, before the turn did anything else —
a round trip in front of somebody holding a phone, taken for a ctx that nothing
until `harness.stream` reads. It is now started at the top and awaited at the
ctx, so the guard and store reads a YES/NO costs overlap it instead of queueing
behind it, and a YES that settles an automation's grant set — which builds no
ctx at all — never waits for it.

The link write moved BEHIND the answer. It has two readers and only one of them
can run during the turn: `vendo_text_me` reads the conversation off that row
(text-me.ts) and nothing else writes it, so a turn that would change what it
reads — a phone's first ever, a conversation that has moved — still waits. The
other reader is the next text on this conversation, and the per-conversation
queue cannot start that turn until this one's promise settles, so awaiting the
write below the reply is early enough for it.

And `vendo_automate` joins the always-active set beside `vendo_text_me`. The
belt is cut safest-first at 24 tools, so on a surface with more reads than that
every WRITE is evicted — which is what buried Text me twice in two days. The
arming tool is a write too, and it is the ONE thing this channel's hidden
grounding tells the model to reach for on every inbound text ("to text the user
later, set up an automation for it"). A texted "text me when the rent clears"
was therefore a `find_tools` round on the first turn of every fresh thread, for
a capability the prompt had just promised.
