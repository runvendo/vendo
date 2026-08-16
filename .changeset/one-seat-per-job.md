---
"@vendoai/core": minor
"@vendoai/harnesses": minor
"@vendoai/apps": minor
"@vendoai/vendo": minor
---

**Breaking:** one model seat per real job — `default`, `apps`, `review`, `judge` — and the old spellings are gone rather than deprecated.

`createVendo({ models })` now takes exactly the four jobs that run: `default` thinks (chat, compaction, subagents, automations), `apps` writes the generated apps, `review` grades the finished ones, `judge` answers the guard's run/ask/block. The old vocabulary named things nobody could act on — `fill` was the app writer, `reviewer` was read by nothing at all, and the app-writing agent silently read `default` while `paint` configured a lane that no longer existed. A seat you cannot point at a job is a seat you cannot set correctly.

Gone, each with a boot error naming its replacement:

- top-level `model` → `models.default`
- top-level `paint` → `models.apps` for the model half, `apps: false` for `disabled`
- the `fill` seat → `apps`; the `reviewer` seat → `review` (which never had a reader and now has one: the AI reviewer)
- `devModel()` → `vendoModel()`
- `VENDO_MODEL_PAINT` → `VENDO_MODEL_APPS`; `VENDO_MODEL_REVIEW` is new
- the `VENDO_EXTRACTION_MODEL` fallback → `VENDO_MODEL_EXTRACT`
- `migrateModelSeats()`, which no production path called

Cloud gateway family ids follow the seats: `vendo`, `vendo-apps`, `vendo-review`, `vendo-judge`, `vendo-extract`. `vendo-paint` is gone, and `vendo-review` is new — so is its env pin, which the reviewer seat never had.

Resolution is one rule stated once: an explicit seat wins; an unset seat borrows `default` — the object when you passed one, its own rung pick when `default` rode the credential ladder. On the Cloud rung each seat resolves to its own family id; on a BYO provider key the reading seats (`review`, `judge`) take the provider's fast model and the writing seats (`default`, `apps`) take its flagship. The app-writing agent now genuinely runs on the seat named after it — it read `default` before, so `models.apps` was a knob that changed nothing.
