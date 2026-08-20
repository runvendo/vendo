# @vendoai/knowledge

## 0.36.1

### Patch Changes

- @vendoai/core@0.36.1

## 0.36.0

### Patch Changes

- Updated dependencies [0108715]
- Updated dependencies [0b6bb92]
- Updated dependencies [2c662ac]
  - @vendoai/core@0.36.0

## 0.35.0

### Patch Changes

- @vendoai/core@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [f7e0ff4]
  - @vendoai/core@0.34.0

## 0.33.0

### Minor Changes

- 8c7b476: Vendo runs on both AI SDK majors. The peer range widens from `ai >=6 <7` to
  `ai >=6 <8`, and the three things that made an `ai@7` host fail are gone: the
  turn loop and the generation engine send their cacheable system block as
  `system` instead of as a system-role message inside `messages` (ai@7 refuses the
  latter with `AI_InvalidPromptError`, and both majors carry the same message form
  — cache breakpoint and all — to the provider unchanged), and the spec-version
  gates on provider failover and the screen agent's per-role seat now admit the
  v4 spec that ai@7-era providers report instead of only v3.

  `vendo doctor` follows: `ai@6` and `ai@7` both pass, a pre-v6 install still
  fails on the peer floor, and E-DEP-001's ceiling moves to majors above the
  supported pair. `vendo init` stops telling an `ai@7` host to downgrade, and the
  "install your provider" line no longer names an `ai` major at all — `ai` is
  already resolved by the time anyone can read it.

  A new `ai-dual` CI lane pins the whole workspace to the ai@7 pairing and runs
  the suites against it, so a peer range that claims two majors is checked rather
  than asserted. This is the compat half of #478, whose short-term half was the
  fail-fast this replaces.

### Patch Changes

- Updated dependencies [8c7b476]
- Updated dependencies [9d3f0af]
  - @vendoai/core@0.33.0

## 0.32.0

### Patch Changes

- @vendoai/core@0.32.0

## 0.31.0

### Patch Changes

- @vendoai/core@0.31.0

## 0.30.1

### Patch Changes

- @vendoai/core@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [56c81b5]
  - @vendoai/core@0.30.0

## 0.29.1

### Patch Changes

- @vendoai/core@0.29.1

## 0.29.0

### Patch Changes

- ebf101a: A hanging knowledge engine no longer taxes every turn. The prompt index asks the
  adapter for `status()` when the sync state moves, and the wire client aborts that
  call at its own 30s timeout — so an engine that was UP but not answering charged
  30 seconds to every single turn before the prompt could be built, forever. A
  status check that fails SLOWLY now leaves the engine alone for a minute; the turns
  inside that window serve exactly what the failed check would have served, minus the
  wait. A check that fails FAST — a refused connection, microseconds — is unchanged
  and still retried on the very next turn, so a recovered engine is picked up at once.
- Updated dependencies [6bc5cc8]
- Updated dependencies [ebf101a]
- Updated dependencies [df0b4cb]
- Updated dependencies [7e78031]
- Updated dependencies [6bc5cc8]
- Updated dependencies [f06b033]
  - @vendoai/core@0.29.0

## 0.28.0

### Patch Changes

- Updated dependencies [650e5eb]
- Updated dependencies [0143c4e]
- Updated dependencies [62c8630]
  - @vendoai/core@0.28.0

## 0.27.1

### Patch Changes

- ebe9ffc: A store that will not hold one collection no longer takes the whole deployment down with it.

  0.27.0 on a Vendo Cloud key served 501 to every route. The hosted store's engine allowlist did not carry two of the collections this version reads — `vendo_automations` and `vendo_app_seen` — and the automations one is read at BOOT, by the code-automations reconcile that rides the `ready()` latch. The latch memoizes, so the first refusal became every route's answer for the life of the process: 2.3 seconds for the first request, 3 milliseconds for every one after, all of them 501, including the routes that never touch an automation.

  Three separate faults, and the deployment needed all three fixed:

  The boot reconcile is no longer the deployment. A store that refuses the automations read leaves code-authored automations off and says so once, in a line the operator can act on; everything else serves. Scoped to that one read — every per-request store failure still fails in the open, where the caller can see it.

  The unseen dot costs the dot, never the answer. `vendo_app_seen` was read on the path that LISTS a person's apps and written on every render, so a store refusing that collection took the whole page of apps with it. A refusal is absorbed there now, once per process, and the apps arrive without their arrival dots.

  And `instanceof VendoError` does not survive a realm boundary. A host bundle can carry two copies of `@vendoai/core` — the ESM `dist/` beside the CJS `dist/cjs/` — and the second copy's VendoErrors are a different class with the same shape, so every `instanceof` gate said no. That is why a blocked collection reached the wire's catch-all as an unknown fault and answered "Internal Vendo error" instead of its own 403.

  `isVendoError` is the check that survives it: `name` plus `code`, the two things any of these gates actually read. Every type-gate in the repo takes it now — 48 of them across the eight packages that had one — because the failure was never specific to the wire. The same class of error decided whether a lost compare-and-swap re-aimed or crashed the workspace façade, whether a swept approval rendered "expired" or an error card, whether a host's knowledge adapter got its code named in the operator's log, whether a permission route answered 403 or threw, and whether a build's "busy, try again shortly" read as "generation failed" — a verdict on an ask that was never the problem. `@vendoai/harnesses` proved the duck check first and kept a private copy of it; that copy is now this one function.

- Updated dependencies [ebe9ffc]
- Updated dependencies [1fb1810]
- Updated dependencies [ebe9ffc]
  - @vendoai/core@0.27.1

## 0.27.0

### Patch Changes

- Updated dependencies [c50597f]
- Updated dependencies [e09d69a]
- Updated dependencies [20aed63]
- Updated dependencies [a6ec9ba]
- Updated dependencies [c50597f]
- Updated dependencies [bfaa06b]
- Updated dependencies [c50597f]
  - @vendoai/core@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [c369e14]
- Updated dependencies [443edd4]
  - @vendoai/core@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [aa1c8db]
  - @vendoai/core@0.25.0

## 0.24.0

### Patch Changes

- @vendoai/core@0.24.0

## 0.23.0

### Patch Changes

- @vendoai/core@0.23.0

## 0.22.0

### Patch Changes

- @vendoai/core@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [6856b4f]
- Updated dependencies [491a2fa]
- Updated dependencies [37ed821]
- Updated dependencies [6856b4f]
  - @vendoai/core@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [095f143]
- Updated dependencies [7fcf60b]
- Updated dependencies [cfd4f48]
  - @vendoai/core@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [2879e46]
- Updated dependencies [39a1c78]
- Updated dependencies [5f4d694]
  - @vendoai/core@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [88ec7e6]
  - @vendoai/core@0.18.0

## 0.17.0

### Patch Changes

- Updated dependencies [c17d492]
- Updated dependencies [64004b6]
- Updated dependencies [85fc732]
- Updated dependencies [8ded5cc]
  - @vendoai/core@0.17.0

## 0.16.0

### Patch Changes

- @vendoai/core@0.16.0

## 0.15.0

### Patch Changes

- ec80477: The local lexical engine's drawers go through the `engine` family instead of the
  generic record façade.

  Generic `records.*` is a host's door onto its own data, and `vendoKnowledge` was
  reaching for two of Vendo's own collections through it — `vendo_knowledge_docs`
  and `vendo_knowledge_chunks`. Nothing in those calls said the collections were
  Vendo's, so nothing could refuse a call that reached for one. Both drawers now
  name their collection through `ops.engine.*`: the same verbs onto the same doors
  with `assertEngineCollection` in front, so per-collection policy is unchanged.

  `vendoKnowledge` takes an optional `ops` alongside `store` for that same store's
  named-operation surface, when the composition could resolve one. Unset — which is what a
  host constructing the engine with its own `StoreAdapter` gets, and what
  `createVendo`'s knowledge seam still passes — the same seven verbs are served
  straight off the adapter's own record doors through core's `engineOverAdapter`,
  so a BYO adapter behaves exactly as before. An engine with neither still fails
  loudly on the operation rather than reporting an empty corpus.

- Updated dependencies [b57df06]
  - @vendoai/core@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [954ad09]
  - @vendoai/core@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [395fc1e]
- Updated dependencies [031195f]
  - @vendoai/core@0.13.0

## 0.12.0

### Patch Changes

- @vendoai/core@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [5c8043d]
- Updated dependencies [e58520e]
- Updated dependencies [863dc53]
  - @vendoai/core@0.11.0

## 0.10.0

### Minor Changes

- 0f46e44: Dead features and their public surface are gone. Every removal below had zero
  callers in this repo, the console, or the examples; nothing changed behavior for
  a caller that was using a live path.

  **`@vendoai/core` (breaking).** `AppDocument.placements` is gone from the
  interface and the schema, and the validator no longer checks it. There has been
  no writer since the placements-as-rows split; "show this app in that slot" is a
  placement ROW (`@vendoai/apps` `placements.ts`, `GET /apps/placements`), which
  is unchanged and is the live feature. Also removed: `PlanIsland` and the
  `AppPlan.island` field, because the plan-level `<Island name purpose/>`
  declaration no longer parses; and `PackSkill`, the deprecated alias for `Skill`.
  `Pin`, `pinSchema` and `AppDocument.pins` are untouched — fork provenance is
  still live.

  **`@vendoai/apps` (breaking).** `PinShipRequest`, `PinApproval`,
  `pinShipRequestSchema` and `pinApprovalSchema` never ran; `ShipDiffPin` and
  `inClientApprovalSchema` are the live path and stay. `bindingKindCheck` is gone
  — it had no callers; the `bindingKindIssues` walker it wrapped is still used by
  the validate path. The plan compiler no longer accepts a plan-level
  `<Island name purpose/>` element (an inline `<Island>` inside an app file is a
  different, live feature and is unchanged). `GenerationPromptSection["id"]`
  narrows to `"theme" | "design-rules"`; the other five ids had no producer.

  **`@vendoai/store` (breaking).** The `stateStore` and `approvalStore` helpers
  are gone. Both were test-only wrappers over the routed `records("vendo_state")`
  and approval write paths, which are unchanged and are what production uses.
  `ApprovalRow` is unaffected — it is exported from `helpers/types.ts` as before.

  **`@vendoai/agents` (breaking).** The `./harnesses` subpath export is gone.
  Import the harness factories from their own package instead:
  `import { claudeCode } from "@vendoai/harnesses/claude-code"` and
  `import { vendo } from "@vendoai/harnesses"`.

  **`@vendoai/knowledge`.** `knowledgeIndexSummary` and `parseKnowledgeConfig` are
  no longer exported from the package root. Both functions stay and are still used
  internally by `knowledgeIndexResolver`, which remains exported.

  **`@vendoai/actions`.** `DEFAULT_CAPTURE_BUDGET_BYTES` is no longer exported.
  The constant and the 256 KB default it sets are unchanged.

  **`@vendoai/ui`.** The unexported, unreferenced `TakeoverPortal` component is
  deleted.

### Patch Changes

- Updated dependencies [e2128aa]
- Updated dependencies [0e51585]
- Updated dependencies [361f9b9]
- Updated dependencies [b0a165c]
- Updated dependencies [e87a765]
- Updated dependencies [79d7088]
- Updated dependencies [89b4444]
- Updated dependencies [0f46e44]
- Updated dependencies [61b75bd]
  - @vendoai/core@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [18c77cd]
  - @vendoai/core@0.9.0

## 0.8.1

### Patch Changes

- 5724311: Knowledge citations keep their provenance on the main search path, and both
  shipped wire engines are one client.

  The built-in local engine denormalized `kind`, `visibility` and `title` from
  the doc into each chunk row but not `source`, so the chat/deep ref shape had no
  `source` while the schema-intent and `fetch` shapes did. Since `toCitation`
  forwards `source` only when it is present, every citation an agent produced on
  the default retrieval path silently lost the file or URL the text came from —
  only glossary lookups and the cloud engine carried it. `source` is now
  denormalized alongside `title` at upsert time and rides the hit ref, so all
  three intents return the same ref shape.

  Existing stores get this without a re-sync. Chunk rows written by earlier
  versions have no `source` field, and `vendo knowledge sync` skips documents
  whose content hash is unchanged, so those rows would never be rewritten —
  search reads through to the document row for them instead. Nothing to run, no
  migration, and the doc row has always carried `source`.

  `cloudKnowledge` and `httpKnowledge` were the same `vendo/knowledge-wire@1`
  client written out twice: identical transport, identical response parsing,
  identical `includeInternal` handling, identical route bodies. Only the base
  path, whether the bearer is mandatory, the posture, and the wording of the
  client's own errors ever differed. They now share one internal client that
  takes those four as arguments, so a retry, header, timeout or status mapping is
  added in one place instead of two that can drift. No behaviour changes for
  either engine.

  `toCitation` is no longer exported from the package barrel. It is the tool's
  own hit-to-citation mapper, it had no importer anywhere, and the citation shape
  it produces is already public as `KnowledgeCitation`.

- Updated dependencies [a7a0fcf]
- Updated dependencies [e092567]
- Updated dependencies [b99147f]
- Updated dependencies [46923cc]
- Updated dependencies [b50a766]
- Updated dependencies [022f789]
- Updated dependencies [354f231]
- Updated dependencies [ee92750]
- Updated dependencies [d599d23]
- Updated dependencies [89660d1]
- Updated dependencies [2b6d60f]
- Updated dependencies [b99147f]
- Updated dependencies [b99147f]
- Updated dependencies [2357b22]
  - @vendoai/core@0.8.1

## 0.8.0

### Minor Changes

- 6eb8a04: **BREAKING:** the knowledge entailment verifier is removed. The knowledge
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

### Patch Changes

- Updated dependencies [2e792a1]
- Updated dependencies [963d980]
- Updated dependencies [3f98372]
- Updated dependencies [21c8b10]
- Updated dependencies [1bb535b]
- Updated dependencies [8d623ec]
- Updated dependencies [a004031]
- Updated dependencies [2722d81]
- Updated dependencies [f884bfe]
- Updated dependencies [a5293af]
- Updated dependencies [b022eb3]
- Updated dependencies [c9df3f7]
- Updated dependencies [6eb8a04]
- Updated dependencies [fbf265b]
- Updated dependencies [2ed91b0]
- Updated dependencies [e6aaa7a]
- Updated dependencies [d0c3cc9]
- Updated dependencies [798b618]
- Updated dependencies [10a2b44]
- Updated dependencies [98eba22]
- Updated dependencies [f7c6da2]
- Updated dependencies [14e8246]
- Updated dependencies [fbf265b]
- Updated dependencies [38a840d]
  - @vendoai/core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [8f5a7c0]
  - @vendoai/core@0.7.0

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
