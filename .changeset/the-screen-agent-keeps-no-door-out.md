---
"@vendoai/vendo": minor
---

The screen agent keeps no door out: `escalate` leaves the loadout.

A tool the model is never handed is a tool it cannot reach for. The `escalate`
hand is gone from the assembly loadout and the bullet that taught it is gone from
the environment note — the loop is equipped with `save_app`, `edit_app` and the
host's read tools, and its own instructions name nothing else. The step-budget
line is now just the budget; it no longer offers leaving as the alternative to
spending it. The shipped building-apps manual keeps its own hedged sentence
("hand it to the builder through `escalate`, **where you have that tool**"),
which is exactly the hedge this change relies on.

What an ask bigger than a screen costs now: an honest failure. `vendo_make`
answers with a failed receipt naming the ask, nothing is painted, and no build
machine is provisioned — even on a deployment that has one sitting there.

The escalation plumbing downstream is untouched: `ScreenOutcome`'s
`kind: "escalate"`, the `create({ prompt, why })` door that hands the in-box
builder a brief, and every `@vendoai/apps` consumer of both still work exactly as
they did. Nothing in this repo reaches them through the screen agent any more —
a host that calls `apps.create` with its own `why` still does.
