---
"@vendoai/core": major
"@vendoai/apps": major
"@vendoai/ui": major
"@vendoai/vendo": major
---

The ✦ gesture collects an instruction, and mints a screen. There are no bare forks: ✦ asks what the person wants BEFORE it fires, and the fork plus that first edit are ONE operation whose output is an ordinary screen app (`app.tsx`, through the ordinary edit door) carrying the remix's provenance — component, baseline, and the instruction, verbatim.

**Breaking, and it reaches data already on disk.** `AppSeed.instruction` is now REQUIRED (`appSeedSchema`, `@vendoai/core`). A remix seed written before this release does not have one, so its app document fails schema validation and that app will not load. There is no migration in this release. A deployment carrying remixes either backfills `seed.instruction` on those rows with the text the remix was made for, or deletes them and lets people remix again. Apps that were never remixes are untouched.

Two doors change shape with it, both refusing a call that used to be legal:

- `seedFrom({ component, slot?, instruction })` — `instruction` is required on `VendoClient.apps.seedFrom` (`@vendoai/ui`) and on `SeedFromInput` (`@vendoai/apps`).
- `POST /apps/seed` (`@vendoai/vendo`) requires `instruction` in the body and answers `validation` — `instruction must be a non-empty string` — without it.

Nothing copies the captured host source into the document any more, and nothing evaluates one: `applySeedFork`/`seededBundle` are gone from the generation engine, `seedOnto` from the seed surface, and the wire save's seeded carry-forward from `authoredDocument`. All three were internal. "Is this remix edited?" is one field read now — `doc.source["app.tsx"] !== undefined`.

A re-seed is RE-IMAGINED rather than kept. When the host ships a new baseline, `reseed` replays the RECORDED INSTRUCTION against it instead of swapping in a pristine copy, so a remix survives its component's redesign as the thing the person asked for. Dedupe per (subject, component) is unchanged, and so is the review lane.

Three dead ends that used to lie now tell the truth:

- **A remix still generating is "not ready", not "broken".** Against a real model the first edit takes 9–38s; `open` answered that window with a validation failure, `useApp` spent its three retries in ~900ms, and nothing asked again — the pill sat on "Remixing…" until someone reloaded the page. A seeded app with no screen now answers the same not-found every app gives before its build lands, which the wire's existing build window turns into `{kind:"pending"}`, and `useApp` keeps asking on the embed's cadence until the screen lands or the ONE shared build deadline runs out. A genuinely tree-less app keeps its validation failure. The ✦ badge reads "Remixing…" off the open payload — the same signal the mount below waits on — so the label and the screen change together instead of the label arriving four seconds early.
- **A fork the build gave up on says so.** A terminal `{kind:"failed"}` lands in the chrome's existing "Didn't load" state, with the server's own reason, instead of reading "Remixed" and "Sandboxed — only you see this" over a page that never got a screen.
- **A failed remix edit never advances the baseline it did not reach.** `edit()` RETURNS `failedEdit` on its common failure path rather than throwing, and both remix doors read only the throw. A re-seed now replays BEFORE it writes the rebased `seed.baseline`, so a refused replay no longer answers 200 with the old screen and the new baseline. A failed first edit leaves the same terminal `buildFailed` marker a failed build leaves, so `open()` answers with the reason and `list()` skips the row — the next tap mints a fresh app instead of being handed the dead one forever.
