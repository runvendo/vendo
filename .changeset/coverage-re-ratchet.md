---
---

No published behaviour changes: the coverage floors re-ratchet to the numbers CI
measures. src/cli/ rejoins @vendoai/vendo's coverage — the CLI fold excluded it
so the then-78 global went on measuring its pre-fold file set — and the umbrella
goes 78 -> 93 with a src/cli/** floor of 92, @vendoai/ui 90 -> 92. A glob is an
additive check and not an exclusion, so the CLI's files are held to both.
