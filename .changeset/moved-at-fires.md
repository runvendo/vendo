---
"@vendoai/vendo": patch
"vendoai": patch
---

A one-shot `{ at }` automation that is re-declared under the same `id` with a new instant fires at that instant. The replace kept the old schedule cursor, whose `firedAt` from the first firing made the tick skip the new one forever while the record showed as armed.
