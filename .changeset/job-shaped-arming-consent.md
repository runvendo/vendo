---
"@vendoai/automations": minor
"@vendoai/vendo": minor
"@vendoai/core": patch
"@vendoai/guard": patch
"@vendoai/apps": patch
---

Arming an automation is ONE page and ONE yes. Live 2026-08-18 on production
Maple: a user armed "check my checking balance every 15 minutes and text me"
entirely over iMessage, their YES to the job landed — and arming then minted four
MORE per-tool asks (Text me, knowledge search, request a connection, list
connections). Three were reads nobody needs a second opinion about, and the
fourth was literally in the sentence they had just typed. Consent was framed
per-tool while the person was thinking per-job.

The authoring call's own approval now NAMES what the automation will hold, and
that one yes mints all of it. The powers ride on the approval record
(`ApprovalRequest.powers`, additive and optional, human titles only), computed
once at park time by the composition and rendered verbatim by whoever reads it —
the text channel today, any other surface without further work. They are grouped
the way a person reads them: the tools that DO something named one by one, and
every read folded into a single trailing "Read-only access to your data", because
naming reads individually is exactly what turned a yes to a job into a wall of
tool names.

What an automation is granted has NOT changed, and neither has how it runs. The
surface is as wide as it ever was, every away call is still grant-backed, and 05
§6's away authority is untouched — the guard's law suites pass unmodified. Two
kinds are excluded from standing powers because a grant could never satisfy them
and the card would be promising what the run will not honour: `destructive` and
`ungraded` (§12's pair, now closed on the two branches that leaked — a steps
record's declared destructive tool, and a connector slug the risk resolver grades
destructive), and `confirmEach`, which needs a person every time.

Minting is gated on a person having actually been asked. `enable()` takes the
authoring call (`armedBy`); when the host's policy would have asked about it, the
call reaching the engine proves the ask was answered, so the powers are minted on
the spot. When policy would have run it unasked — `vendo_make` is read-graded —
nobody saw a powers page, so nothing is minted and each power is captured as a
pending ask exactly as before, delivered by the grant-set text.
