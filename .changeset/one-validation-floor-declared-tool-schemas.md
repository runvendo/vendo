---
"@vendoai/apps": minor
---

One validation floor at every door, and a host's declared tool schemas finally
reach the screen type check.

Four doors let an app reach a screen — the paint seam, `validate({ document })`,
`validate({ appId })` and the edit path — and each ran a different subset of the
checks, so an app refused at one shipped through another. An island that crashes
the moment it renders was caught at exactly one of them. All four now compose
the same `floorChecks`: the fact checks, the compiler static half, and the island
gates (admission plus the smoke render). The AI reviewer has not moved — it still
runs only where it ran before, at `validate`, because it spends a model call.

The island gates move from `generation/validation/` into `checking/`, where the
floor that runs them lives; the generation pipeline imports them from there. On
the paint hot path a repeated save costs ~3ms more, because the smoke render is
keyed on island source and an unchanged island never renders twice.

`screenTypings` has always preferred a tool's DECLARED `outputSchema` over the
shape sampled from one live call, and nothing ever populated it. It does now, so
a screen is type-checked against the host's own contract. Sampling erases what a
declaration keeps: an enum field samples as a bare `string`, so a host component
whose prop takes that enum could never be satisfied by any tool — demo-bank's
`MapleSpendingDonut` against `host_getSpendingInsights` was blocked at the checks
floor on a screen that was correct.
