# @vendoai/knowledge

## 0.6.1

### Patch Changes

- @vendoai/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [89153f8]
- Updated dependencies [3ae3d13]
  - @vendoai/core@0.6.0

## 0.5.0

### Minor Changes

- c7277f6: Knowledge verifier pass: where the evidence score provably cannot decide, a cheap model does.

  Calibration against the cloud engine found that answerable and unanswerable questions score in the same range, so at the best possible bar 47% of unanswerable questions still got a confident answer. `@vendoai/knowledge` now exports `entailmentVerifier`: a capped, schema-constrained check that reads the passages a search returned and decides whether they can answer the question at all. An unsupported verdict becomes the existing `insufficient-evidence` outcome, carrying the gap the verifier named so the agent can say WHAT the docs do not cover.

  **It is not score-gated.** It reads every search that returns hits. An earlier design ran it only inside a calibrated score band; the live run showed four unanswerable questions per pass scoring outside that band, never being checked, and being answered — so a check gated on the number it exists to replace inherits that number's blind spots.

  **What it is measured to do.** Live against the cloud engine over the 94-question corpus: false answers 7/34 and 10/34 on its two passes, false refusals 3/60, reading 94/94 searches at 1.37-1.39 model calls per search and adding p50 ~2.5s of verification to a verified turn (summed over that turn's calls; one call's median is ~1.7-1.8s). It reduces confident wrong answers sharply — the same corpus loses 19/34 with the check gated to a score band — but it does not eliminate them, because it cannot refuse when a verification times out and it is sometimes simply wrong. The per-question records and the full table, including the removed gated configuration, are in `docs/eval/KNOWLEDGE.md`.

  **OFF by default.** `VENDO_KNOWLEDGE_VERIFY=on` opts in for the Cloud engine; a value that is neither on nor off throws at composition rather than silently disabling a trust feature. It ships off because the measurement says it does not clear the zero-false-answer bar it exists for, while costing a model call per search and seconds on a call the user waits through — that trade is the host's to make, not a default. Only the Cloud engine composes it; BYO and self-hosted engines are untouched.

  **Enabling the check changes no threshold.** The host's `weakScoreThreshold` (default 0) is exactly what it was, and it still decides every search the check could not read. When there is a verdict the verdict decides, in both directions.

  **It fails open, and says so.** No model, a timeout, or an unusable response yields no verdict: the tool answers the way it would have without a verifier and marks the result with the additive `unverified` field on `vendo/knowledge-result@1`. The thread renders that as the amber "I couldn't check this answer against the documentation" line beside the sources, so a check that did not run is never mistaken for one that passed. Verification is capped per TURN as well as per call, so a chat→deep escalation cannot spend the cap twice.

  An empty or placeholder gap ("", "n/a", "none") fails the verdict schema, so a verdict with its evidence torn off yields no verdict at all and the tool falls open marked, rather than refusing a user with a reason that says nothing.

  The verifier rides its own `knowledgeVerifier` model slot (`VENDO_MODEL_KNOWLEDGE_VERIFIER`, `models.knowledgeVerifier`) beside `judge` — pinning the model that grades answers no longer repoints the one that gates them.

  `@vendoai/knowledge` now declares `ai` as a peer dependency (with the zod floor every ai peer needs), matching `@vendoai/guard`.

### Patch Changes

- b1ba2ec: Scaffold `@vendoai/knowledge` — the package that will hold the KnowledgeAdapter engines (local, cloud client, BYO HTTP template) and ingestion, behind core's frozen contract. Stage 0: package + toolchain only, exporting the store collection names the local engine binds to (`vendo_knowledge_docs` / `vendo_knowledge_chunks`). Added to the fixed version-lockstep group.
- Updated dependencies [0b58e3e]
- Updated dependencies [cbffc9e]
- Updated dependencies [c7277f6]
- Updated dependencies [da9d4a9]
- Updated dependencies [f5fbb4b]
- Updated dependencies [221b851]
- Updated dependencies [d1364b6]
  - @vendoai/core@0.5.0
