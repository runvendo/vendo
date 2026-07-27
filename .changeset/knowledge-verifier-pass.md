---
"@vendoai/knowledge": minor
"@vendoai/vendo": minor
"@vendoai/core": minor
"@vendoai/agent": minor
"@vendoai/ui": minor
---

Knowledge verifier pass: where the evidence score provably cannot decide, a cheap model does.

Calibration against the cloud engine found that answerable and unanswerable questions score in the same range, so at the best possible bar 47% of unanswerable questions still got a confident answer. `@vendoai/knowledge` now exports `deriveVerifyBand` (the overlap region of the two calibration populations) and `entailmentVerifier` (a capped, schema-constrained check that the returned passages can support an answer at all). Inside the band the verifier adjudicates and an unsupported verdict becomes the existing `insufficient-evidence` outcome, carrying the gap the verifier named so the agent can say WHAT the docs do not cover. Outside the band nothing changes.

**What it is measured to do.** Live against the cloud engine over the 94-question corpus, three passes: false answers 16/34 · 12/34 · 10/34 and false refusals 3/60 every pass, with the verifier producing 73 refusals a score threshold alone would not have made. It reduces confident wrong answers; it does not eliminate them, because it only sees the searches the band routes to it and it cannot refuse when it has no verdict. The per-question records and the full table are in `docs/eval/KNOWLEDGE.md`.

**On by default for the Cloud engine.** `VENDO_KNOWLEDGE_VERIFY=off` is the explicit opt-out; a value that is neither on nor off throws at composition rather than silently disabling a trust feature. Only the Cloud engine verifies: scores are engine-relative and no other engine has been calibrated, so a BYO or self-hosted engine is untouched.

**Enabling the check changes no threshold.** The band decides who adjudicates, never what is decided — the host's `weakScoreThreshold` (default 0) is exactly what it was.

**It fails open, and says so.** No model, a timeout, or an unusable response yields no verdict: the tool answers the way it would have without a verifier and marks the result with the additive `unverified` field on `vendo/knowledge-result@1`. The thread renders that as the amber "I couldn't check this answer against the documentation" line beside the sources, so a check that did not run is never mistaken for one that passed. Verification is capped per TURN as well as per call, so a chat→deep escalation cannot spend the cap twice.

The verifier rides its own `knowledgeVerifier` model slot (`VENDO_MODEL_KNOWLEDGE_VERIFIER`, `models.knowledgeVerifier`) beside `judge` — pinning the model that grades answers no longer repoints the one that gates them.

`@vendoai/knowledge` now declares `ai` as a peer dependency (with the zod floor every ai peer needs), matching `@vendoai/guard`.
