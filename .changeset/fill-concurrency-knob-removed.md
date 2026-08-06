---
"@vendoai/vendo": major
"@vendoai/apps": major
---

**BREAKING:** the `apps.fillConcurrency` config knob is removed —
`createVendo({ apps: { fillConcurrency } })`, `AppsConfig.fillConcurrency`,
and `ConductorOptions.fillConcurrency` are gone.

Nothing ever set it: not the umbrella's own composition, not a demo, not a
doc beyond the config listing, so every fill has always run at the built-in
default of 2 groups at a time and still does. `fillPlan`'s own `concurrency`
option (the internal dial the fill tests exercise) is unchanged; only the
never-wired public spelling is removed. A host that passes it will now get a
type error — delete the key, the behavior is identical.
