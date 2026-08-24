---
"@vendoai/apps": minor
---

ask before spending a build machine: an ask the screen agent escalates now raises a standing approval card and `vendo_make` returns a receipt with the new status `awaiting-consent`, so the turn ends having claimed no sandbox. The person's yes — whenever it lands, possibly long after that turn is gone — is what starts the build: `AppsRuntime.build.propose` parks the ask against its approval (`vendo_parked_build`) and writes it onto the app row as a `proposal`, and the guard's decision alone runs the new `AppBuilder` seam and seals what it built. A no clears the proposal and leaves the honest failure card, with no box ever opened. `validateAppDocument` now refuses a document carrying both `proposal` and `building`
