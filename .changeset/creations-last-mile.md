---
"@vendoai/core": minor
"@vendoai/apps": minor
"@vendoai/ui": minor
---

Built apps, last mile: a standing consent card a person can actually answer. An approval that was already waiting when the page loaded now raises its card on mount instead of only after — a build ask can outlive the tab that raised it, and the yes is meant to work whenever it lands, so an ask that only existed while you were watching was not a standing one. The card also says what it is asking: it reads the same plain-words ladder the approval card and its queue row read (the ask as a question, then every real input under it) rather than a bare tool label, it offers Deny beside Approve, and `vendo_app_build` joins the shared title table, so the consent moment reads "Build this app for real?" instead of "Vendo app build". Once the yes lands, the build's own status line reaches the person on that same surface — a detached build has no turn to stream into, and `useApp` now hands back the `status` the build window's poll was already receiving and discarding. A toast's hint moved under its text rather than beside its buttons, which is where it has to be to carry a sentence.
