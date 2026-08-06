---
"@vendoai/knowledge": major
"@vendoai/core": major
"@vendoai/agent": major
"@vendoai/ui": major
"@vendoai/vendo": major
---

**BREAKING:** the knowledge entailment verifier is removed. The knowledge
stack is a pure retrieval plug-in again, and `weakScoreThreshold` is once more
the sole refusal calibration — unchanged, and still the knob to tune.

The check shipped off by default and the live measurement is why it never got
turned on: over the 94-question corpus it still answered 7-10 of 34
unanswerable questions per pass, while costing a model call per search and
seconds of latency on a call the user waits through. It never cleared the bar
it existed for, so it is gone rather than left as a knob nobody should set.

Removed surface:

- `@vendoai/knowledge`: `entailmentVerifier`, `KNOWLEDGE_VERIFY_TIMEOUT_MS`,
  `KNOWLEDGE_VERIFY_TURN_BUDGET_MS`, the `KnowledgeVerifier` /
  `KnowledgeVerdict` / `KnowledgeVerifierInput` / `KnowledgeVerifierPassage` /
  `KnowledgeVerifyOptions` / `EntailmentVerifierOptions` types, and the
  `verifier` + `verifyTurnBudgetMs` options on `createKnowledgeTools`. The tool
  reverts to its pre-verifier decision rule: chat search → one deep retry on
  weak evidence → structured `insufficient-evidence`.
- `@vendoai/core`: the `verifier` model seat (`Seat`, `SEATS`,
  `ResolvedModels`, `migrateModelSeats`) and the `unverified` field on the
  `data-vendo-citations` stream part.
- `@vendoai/vendo`: the `VENDO_KNOWLEDGE_VERIFY` and
  `VENDO_MODEL_KNOWLEDGE_VERIFIER` environment knobs, and the
  `models.verifier` / `models.knowledgeVerifier` slots.
- `@vendoai/ui`: the amber "I couldn't check this answer against the
  documentation" line. The engine-outage flag and the structured
  searched-line are untouched.
