---
"@vendoai/vendo": minor
"@vendoai/automations": patch
---

An automation armed from a phone can now be allowed to run from that phone. On
2026-08-18 a user set up "check my checking balance every 15 minutes and text
me" entirely over iMessage. The arming approval worked — the card went out as a
text, their YES decided it — but arming also minted four pending standing-grant
captures, and those asks are approval ROWS the engine writes during
`vendo_automate`, never stream parts, so the mid-turn card watcher could not see
them and their only surface was the host app's web approvals feed. A person who
only texts can never reach it: every firing then ran without the Text me
permission, and the agent could only report that "there are still some
permissions pending approval" with nothing the person could do about it.

After a channel turn finishes, one automation's outstanding permissions now go
out as ONE more text — the automation named the way every other surface names it,
one line per thing to allow, each line the descriptor's own human title:

    check my checking balance and text me — needs your permission to run on its own:
    - Text me
    - Look it up in the docs
    Reply YES to allow all of these, or NO to cancel it.

YES decides the whole set in one batch call on the same guard door the web feed
uses — all-or-none, never a half-granted set — and each approval settles into its
standing grant through the automations engine's own decision subscriber. NO is
the bare no it has always been: nothing is minted and the automation is turned
off, and the reply says which of the two happened. The consent model is
unchanged — the same captures, the same grants, the same one decision that
settles them; only the delivery is new.

One question at a time, the discipline the cards already keep: nothing goes out
while the conversation is holding a card or a set ask it has not answered, the
row is written only after the text lands, and a set is never asked twice. The
store's pending feed is the source of truth rather than "did this turn arm
something", so a set minted from the web is asked on the next texted turn too.
