---
"@vendoai/knowledge": minor
"@vendoai/vendo": minor
---

Knowledge verifier pass: where the evidence score provably cannot decide, a cheap model does.

Calibration against the cloud engine found that answerable and unanswerable questions score in the same range, so at the best possible bar 47% of unanswerable questions still got a confident answer. `@vendoai/knowledge` now exports `deriveVerifyBand` (the overlap region of the two calibration populations) and `entailmentVerifier` (a capped, schema-constrained check that the returned passages can support an answer at all). Inside the band the verifier adjudicates and an unsupported verdict becomes the existing `insufficient-evidence` outcome; outside it nothing changes. Measured on the 94-question calibration corpus: false answers 47% → 3%, false refusals 12% → 7-10%.

`createVendo` wires it for the Cloud engine only — scores are engine-relative, and no other engine has been calibrated. It can never make knowledge unavailable: no model, a timeout, or an unusable response yields no verdict and the tool answers as it would have without it. `VENDO_KNOWLEDGE_VERIFY=off` turns it off.

`@vendoai/knowledge` now declares `ai` as a peer dependency (with the zod floor every ai peer needs), matching `@vendoai/guard`.
