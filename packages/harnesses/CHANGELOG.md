# @vendoai/harnesses

## 0.37.0

### Patch Changes

- Updated dependencies [853c591]
  - @vendoai/apps@0.37.0
  - @vendoai/core@0.37.0
  - @vendoai/guard@0.37.0

## 0.36.5

### Patch Changes

- @vendoai/core@0.36.5
- @vendoai/guard@0.36.5
- @vendoai/apps@0.36.5

## 0.36.4

### Patch Changes

- Updated dependencies [833fec6]
  - @vendoai/core@0.36.4
  - @vendoai/apps@0.36.4
  - @vendoai/guard@0.36.4

## 0.36.3

### Patch Changes

- @vendoai/core@0.36.3
- @vendoai/guard@0.36.3
- @vendoai/apps@0.36.3

## 0.36.2

### Patch Changes

- 66cf10a: A workspace upload the box never received no longer reads as the user deleting
  everything.

  The `claudeCode()` turn puts the workspace on the box before the model runs, and
  that upload was the one unguarded network call in the turn. When it died before
  the box applied it — a refused connect, a dead socket, a first chunk that never
  landed — the turn's `finally` still read the box's disk back, the box answered
  honestly that it held nothing, and the sync-back read "nothing here" as "the user
  deleted everything" and erased the whole workspace from the store. The failed
  READ was already guarded ("an EMPTY read is not the same fact as the user deleted
  everything"); this was the same fact from the other end, and it had no guard.

  Now the turn tracks whether the box actually holds the checkout, and syncs back
  only if it does. A machine that never received the workspace makes no statement
  about it: the store keeps what it had and the next turn recovers on a fresh box,
  exactly as a machine that died mid-turn already did.

  Two things that made it hard to survive and hard to diagnose are fixed with it.
  The workspace calls — the upload and the turn-end read, both of which are the
  same twice — are now sent again once if the transport drops, so a blip no longer
  costs the turn. And a Cloud sandbox that cannot be reached now says so: the
  adapter turns the transport fault into a named `sandbox-unavailable` failure
  carrying the cause, and the runtime's operator log prints the ROOT of that cause
  chain alongside the message. The observed failure used to reach the log as
  undici's bare `fetch failed` — three words naming neither Vendo nor the call.

  The retry is what made the rest necessary. Aborting a request cancels this host's
  leg of it and nothing else, so a chunk this host gave up on can still land after
  its own replay — and the first chunk of an upload carries the reset that empties
  the box's root. Every materialize now mints a GENERATION and carries it on each
  chunk: the box refuses a generation it has already moved past, empties the root
  once per generation instead of once per request, and reports the generation it
  holds. That report is also how a box whose supervisor RESTARTED — same machine,
  same token, empty disk — stops passing as the box that holds the conversation:
  the host reads its own generation back before it treats an empty disk as news.

  **The box image must be rebaked for the generation to take effect** — half of it
  lives in the machine image, beside the supervisor. A host on this version against
  an older image is safe but unprotected: the box ignores the generation it is sent
  and reports none, and an absent report is tolerated on purpose, so the seam
  behaves exactly as it did before rather than refusing every sync-back until the
  rebake lands. Such a turn now logs `harnesses.claude-code-box-no-generation`, so
  the unprotected window is visible while it is open.

  And the retry itself now knows what a retry is for. It replayed everything,
  including answers — a meter refusal, a rejected key, a machine the provider had
  destroyed — and threw the first error away to say the second one twice. Only a
  call that DROPPED may be sent again, only while the box is still waiting for it,
  and the attempt that failed is logged rather than discarded.

- Updated dependencies [91595d2]
  - @vendoai/apps@0.36.2
  - @vendoai/core@0.36.2
  - @vendoai/guard@0.36.2

## 0.36.1

### Patch Changes

- Updated dependencies [a9fca38]
  - @vendoai/apps@0.36.1
  - @vendoai/core@0.36.1
  - @vendoai/guard@0.36.1

## 0.36.0

### Patch Changes

- 2c662ac: On the sandbox rung, warming the chat now warms the machine the conversation
  actually runs on. `POST /threads/warm` — the call the panel fires when the chat
  surface opens — replays a real turn under a throwaway thread id, and the box
  pool keyed on that id: so every warm call booted a real cloud box the user's
  first message could never find, paid a full cold boot anyway, and left the warm
  box idling its whole billed TTL before being destroyed unused. Warming cost a
  box and bought nothing but the provider's prompt cache.

  A warm turn's box is now parked as a warm SPARE, and the first real
  conversation claims it: re-keyed to its own thread, liveness-probed on the way
  in, and handed over exactly as a fresh box is — the workspace is materialized
  and the session opened for that conversation, so nothing of the probe's turn
  carries into the user's first message. A spare that died in the meantime falls
  back to a cold boot, a second warm reuses the live spare instead of booting a
  second box, and a spare nobody ever claims is reaped on the same idle budget as
  any other box.

  Each box now says how it was obtained, so the saving is greppable rather than
  inferred: `harnesses.claude-code-box-ready` reports `thread-reuse`,
  `spare-claim` or `cold-boot`, with the time it took.

  `WARM_THREAD_PREFIX` is new in `@vendoai/core` — the thread-id prefix a warm
  turn carries. It is what the pool reads to recognise one, since `Harness` is
  deliberately unchanged: a warm turn is an ordinary turn, and the id is the
  whole of the seam.

- Updated dependencies [f325443]
- Updated dependencies [0108715]
- Updated dependencies [0b6bb92]
- Updated dependencies [2c662ac]
  - @vendoai/apps@0.36.0
  - @vendoai/core@0.36.0
  - @vendoai/guard@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies [ea60d95]
- Updated dependencies [ea60d95]
  - @vendoai/apps@0.35.0
  - @vendoai/core@0.35.0
  - @vendoai/guard@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [f7e0ff4]
- Updated dependencies [f7e0ff4]
  - @vendoai/apps@0.34.0
  - @vendoai/core@0.34.0
  - @vendoai/guard@0.34.0

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
  - @vendoai/apps@0.33.0
  - @vendoai/core@0.33.0
  - @vendoai/guard@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies [88cf572]
  - @vendoai/apps@0.32.0
  - @vendoai/core@0.32.0
  - @vendoai/guard@0.32.0

## 0.31.0

### Patch Changes

- @vendoai/core@0.31.0
- @vendoai/guard@0.31.0
- @vendoai/apps@0.31.0

## 0.30.1

### Patch Changes

- Updated dependencies [6bbc8e6]
  - @vendoai/apps@0.30.1
  - @vendoai/core@0.30.1
  - @vendoai/guard@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [b3d92b2]
- Updated dependencies [bd1d016]
- Updated dependencies [56c81b5]
  - @vendoai/apps@0.30.0
  - @vendoai/core@0.30.0
  - @vendoai/guard@0.30.0

## 0.29.1

### Patch Changes

- @vendoai/core@0.29.1
- @vendoai/guard@0.29.1
- @vendoai/apps@0.29.1

## 0.29.0

### Patch Changes

- ebf101a: `agent_run`'s `guardMs` and `toolsMs` now carry real numbers. The breakdown
  shipped with both hardcoded to `0` because the tool bridge — the one place that
  stands in front of the guard's evaluation and the tool's own run — had no way to
  reach the turn's collector, so a turn whose nine seconds went into a judge and a
  slow host tool reported them as thinking time. The bridge now takes the same
  `TurnTimings` the runtime already holds and marks the two phases it owns, summed
  over the turn's calls. They are disjoint — the preview decides, the dispatch runs
  on that verdict — so neither is counted into the other and `modelMs`, which is
  whatever the other four leave over, stays honest. Durations only: a mark says how
  long the guard took to decide and how long the tool took to run, never what was
  called, argued or judged.
- ebf101a: A slow turn now says WHERE it was slow. `agent_run` carried one wall-clock
  number and a `steps` field hardcoded to `0`, so the only honest answer to "why
  did that take nine seconds" was to guess. It now carries `ttftMs` — how long
  the person waited for the first word — plus the five phase marks the wall time
  splits into (`storeMs`, `promptMs`, `modelMs`, `toolsMs`, `guardMs`), and
  `steps` is the turn's real model-call count. `durationMs` starts at the top of
  the turn rather than after the opening store reads, which is why a slow store
  used to be invisible in it. Durations and counts only: a breakdown says how
  long, never what was read, prompted, thought, called or judged.
- ebf101a: A tool call is decided once instead of twice. Every guarded call ran the whole
  policy pipeline twice for one logical call: the harness previews with
  `previewCheck` before it dispatches, and the guard-bound registry then evaluated
  the same call again from scratch moments later — the grants read, the approvals
  read, the rules, the org layer and, worst of all, the judge (up to 15 seconds,
  paid twice). The preview's verdict now carries to the dispatch that follows it,
  single-use and pinned to that exact call: same id, same arguments, same
  descriptor, same subject, venue, presence and app, or it is decided fresh.

  Nothing the guard refused before gets through. The preview was always the whole
  evaluation — it just never SPENT anything — so the dispatch is what commits, and
  a verdict only answers for the dispatch moments behind it: it expires after five
  seconds, and every gate that can still stop the call is re-read before anything
  is spent. The kill switch is read first, so a freeze landing between the two
  passes no longer burns the human's single-use yes on a call it then blocks. The
  call-rate window and the write budget are read live and can still park a
  previewed "run" that a concurrent call has since put over budget. The org-admin
  layer is consulted again, so an admin who tightens the layer while a call sits
  previewed clamps that call. The risk GRADE is re-resolved rather than remembered,
  so a tool that previewed as `read` and re-grades to `destructive` cannot reach an
  away run on the old label — THE LAW's unattended gate never reads a stale grade.
  A standing grant is re-read and the single-use yes is claimed last, after every
  gate above, so a call that does not proceed spends nothing. Any of these voids
  the verdict and the full pipeline decides again. An "ask" is never carried
  forward at all — the tap that answers it IS the fresh verdict the dispatch reads.

  The judge is asked once per call, so a subject's outstanding previewed verdicts
  are voided the moment ANY call for that subject lands — at any risk grade, in any
  run or session. The judge decides on the audit trail, and that trail is the
  subject's, not the run's: a step whose tools were all previewed before any of them
  dispatched would otherwise let the second call run on a verdict taken before the
  first one existed, and a landed read or a landed connector call is exactly the
  shape a judge most wants to weigh. Sequential calls — preview, then dispatch with
  nothing in between — have no outstanding verdict to void and keep the single pass.

  Host-API calls also ride the keep-alive connection pool the store already uses.
  Node's stock dispatcher drops an idle socket after ~4s — shorter than the gap
  between two of an agent's tool calls — so nearly every host round trip was paying
  a fresh TCP+TLS handshake. Inference rides the same pool: the composed model
  seats now dial the Cloud gateway through it, so a turn does not re-handshake
  after every idle gap. A host that passes its own `fetch` — or its own ai-SDK
  model object — still wins.

  A refused connect check costs one broker lookup instead of two. The connect gate
  runs twice for one tool call — the harness preflight rules a call to an
  unconnected service out before an approval can be minted for it, and the
  gate-wrapped registry rules it out again on the doors that never preview — and
  only the CONNECTED answer was cached, so every unconnected call asked the broker
  twice to say the same no. A negative answer is now trusted for one second: long
  enough for the two checks of one call, far short of an OAuth round trip, so a
  user who just connected is never told otherwise.

- ebf101a: A turn stops doing its setup one thing at a time. The system prompt is now
  assembled BESIDE the turn's opening store reads instead of after them, and the
  two independent waits inside it — the guard's directions and the knowledge index
  — run together rather than in sequence; the assembled bytes are unchanged,
  because section order comes from the assembler and not from which read settles
  first. The runtime no longer re-validates the composed turn's transcript against
  itself: composition hands it the very array it just read and validated, and one
  array cannot differ from itself, so an O(n) double stringify per turn was
  spent proving a tautology. `vendo()` projects the host's catalog once to set a
  turn up instead of twice, and re-projects it after a tool call only when that
  call could actually change what is reachable — the connector door — rather than
  after every call.

  Fixes a compaction accounting bug in the same pass: the prompt estimate billed
  every equipped tool while the call only ever carries the active loadout, so a
  curated surface was charged for a catalog it never sent — the trigger fired on
  tokens that were never there, and the shed floor was handed a figure the prompt
  had never reached. The estimate bills the active set now. The characters-per-token
  ratio is unchanged.

- Updated dependencies [6bc5cc8]
- Updated dependencies [ebf101a]
- Updated dependencies [0484a15]
- Updated dependencies [df0b4cb]
- Updated dependencies [7e78031]
- Updated dependencies [ebf101a]
- Updated dependencies [6bc5cc8]
- Updated dependencies [f06b033]
  - @vendoai/core@0.29.0
  - @vendoai/apps@0.29.0
  - @vendoai/guard@0.29.0

## 0.28.0

### Patch Changes

- Updated dependencies [650e5eb]
- Updated dependencies [0143c4e]
- Updated dependencies [62c8630]
- Updated dependencies [0143c4e]
  - @vendoai/core@0.28.0
  - @vendoai/apps@0.28.0
  - @vendoai/guard@0.28.0

## 0.27.1

### Patch Changes

- ebe9ffc: A store that will not hold one collection no longer takes the whole deployment down with it.

  0.27.0 on a Vendo Cloud key served 501 to every route. The hosted store's engine allowlist did not carry two of the collections this version reads — `vendo_automations` and `vendo_app_seen` — and the automations one is read at BOOT, by the code-automations reconcile that rides the `ready()` latch. The latch memoizes, so the first refusal became every route's answer for the life of the process: 2.3 seconds for the first request, 3 milliseconds for every one after, all of them 501, including the routes that never touch an automation.

  Three separate faults, and the deployment needed all three fixed:

  The boot reconcile is no longer the deployment. A store that refuses the automations read leaves code-authored automations off and says so once, in a line the operator can act on; everything else serves. Scoped to that one read — every per-request store failure still fails in the open, where the caller can see it.

  The unseen dot costs the dot, never the answer. `vendo_app_seen` was read on the path that LISTS a person's apps and written on every render, so a store refusing that collection took the whole page of apps with it. A refusal is absorbed there now, once per process, and the apps arrive without their arrival dots.

  And `instanceof VendoError` does not survive a realm boundary. A host bundle can carry two copies of `@vendoai/core` — the ESM `dist/` beside the CJS `dist/cjs/` — and the second copy's VendoErrors are a different class with the same shape, so every `instanceof` gate said no. That is why a blocked collection reached the wire's catch-all as an unknown fault and answered "Internal Vendo error" instead of its own 403.

  `isVendoError` is the check that survives it: `name` plus `code`, the two things any of these gates actually read. Every type-gate in the repo takes it now — 48 of them across the eight packages that had one — because the failure was never specific to the wire. The same class of error decided whether a lost compare-and-swap re-aimed or crashed the workspace façade, whether a swept approval rendered "expired" or an error card, whether a host's knowledge adapter got its code named in the operator's log, whether a permission route answered 403 or threw, and whether a build's "busy, try again shortly" read as "generation failed" — a verdict on an ask that was never the problem. `@vendoai/harnesses` proved the duck check first and kept a private copy of it; that copy is now this one function.

- ebe9ffc: A run whose LAST save never reached the screen stops answering "your card is live".

  A screen build saves as it goes, and the run kept two different facts about those saves: `assembled`, which means bytes reached the store at least ONCE and is never unset, and `painted`, which means the LAST save reached the person's screen. The outcome was gated on the first of them. So a build whose early save cleared the checks floor and whose last one did not still answered "assembled" — and because the earlier paint had left a row, the front door found it, stamped the receipt `ready`, and spoke the model's own closing words over a card that was stale or half-written. The field case read "Your card is live!" over an empty one.

  `painted` is a three-state fact now — painted, refused, or nobody judged (an unwrapped workspace claims nothing) — and the outcome is gated on it: a run whose last save the floor refused is `unavailable`, carrying the floor's own sentences, on the same carrier a deployment-level refusal already travels. The person is told what is wrong with the screen they asked for, and MCP callers stop hearing the generic "produced nothing renderable" on an ordinary refusal. A run whose last save painted is unchanged, the reviewer's repair round included: the screen it repairs has already painted, and whatever survives it still stands.

  Also: four `catch {}` blocks that swallowed the cause whole — the BYO tool pack's execute and delegate, and the harness tool bridge's and turn tools' — now say what threw, to the host's log. The wire keeps its generic sentence, because raw internals are not the model's business; a `VendoError` from a host tool was written FOR the model, so the pack and the bridge forward its own code and message rather than masking "list them first" behind "Tool execution failed."

- 1fb1810: A timed-out approval ask settles as expired, not as the person's no. The
  APPROVAL_WAIT_MS settle used to ride the ai-SDK's `output-denied` state — whose
  meaning is "the person answered no" — so the thread narrated "you declined it"
  for a question nobody answered, and the persisted part carried nothing that
  could ever tell the difference. The settle now carries a typed outcome
  (`status: "blocked"` with `cause: "expired"` — a field on the existing member,
  not a new status, so already-published validators pass it through and older
  chrome degrades to "wasn't allowed", which at least blames no one), the beat
  reads "the approval expired unanswered", and the distinction survives reload
  because the part settles as `tool-output-available` with the outcome on it.
  The model-facing result is unchanged: the same denial naming the approval it
  still needs.
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [1fb1810]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
  - @vendoai/core@0.27.1
  - @vendoai/apps@0.27.1
  - @vendoai/guard@0.27.1

## 0.27.0

### Patch Changes

- Updated dependencies [c50597f]
- Updated dependencies [e09d69a]
- Updated dependencies [a781798]
- Updated dependencies [e09d69a]
- Updated dependencies [e09d69a]
- Updated dependencies [20aed63]
- Updated dependencies [49e1e39]
- Updated dependencies [af2d337]
- Updated dependencies [c50597f]
- Updated dependencies [a6ec9ba]
- Updated dependencies [c50597f]
- Updated dependencies [bfaa06b]
- Updated dependencies [c50597f]
- Updated dependencies [77a6765]
- Updated dependencies [b10d129]
  - @vendoai/core@0.27.0
  - @vendoai/guard@0.27.0
  - @vendoai/apps@0.27.0

## 0.26.0

### Minor Changes

- c369e14: **Breaking:** one model seat per real job — `default`, `apps`, `review`, `judge` — and the old spellings are gone rather than deprecated.

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

### Patch Changes

- Updated dependencies [c369e14]
- Updated dependencies [443edd4]
  - @vendoai/core@0.26.0
  - @vendoai/apps@0.26.0
  - @vendoai/guard@0.26.0

## 0.25.0

### Minor Changes

- aa1c8db: The harness turn now opens with ONE `turn.load` and closes with ONE `turn.commit` on a store that serves them. A quiet turn against a hosted mount costs three calls — the envelope, the user's message (landed before the model runs, so a turn that dies never loses it), the envelope — where it used to cost six. Feature-detected against `/status` once per deployment and never blind-sent: below `STORE_WIRE_TURN_OPS`, and on any store with a SQL handle (already one hop from its rows), every door reads and writes exactly as it always did, retry and per-write isolation included. Per-tool-call writes are untouched by design: the guard's audit row, the effect ledger, the workspace commit after every tool call, and the parked-approval checkpoint all stay per occurrence.

### Patch Changes

- Updated dependencies [aa1c8db]
- Updated dependencies [aa1c8db]
  - @vendoai/guard@0.25.0
  - @vendoai/core@0.25.0
  - @vendoai/apps@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [42b2b78]
  - @vendoai/apps@0.24.0
  - @vendoai/core@0.24.0
  - @vendoai/guard@0.24.0

## 0.23.0

### Patch Changes

- @vendoai/core@0.23.0
- @vendoai/guard@0.23.0
- @vendoai/apps@0.23.0

## 0.22.0

### Patch Changes

- Updated dependencies [90c0de8]
  - @vendoai/guard@0.22.0
  - @vendoai/core@0.22.0
  - @vendoai/apps@0.22.0

## 0.21.0

### Minor Changes

- 6856b4f: The wire format (`app.vendo`) and the plan dialect (`plan.vendo`) are gone. One
  artifact writes a screen now — `app.tsx`, a React component through the sealed
  screen engine — so there is one security model, one execution engine and one
  renderer. The tree stays: it is still the JSON currency the renderer paints.

  Removed from `@vendoai/apps/contract`: `compileWire`, `WireCompileOptions`,
  `WireCompileResult`, `expandInlineRefs`, `InlineRefsResult`, `WIRE_ISSUE_CODES`,
  `WIRE_ADVISORY_ISSUE_CODES`, `isAdvisoryWireIssue`, `WireIssue`, `WireIssueCode`,
  `printWire`, `WirePrintInput`, `WirePrintOptions`, `compilePlan`,
  `PlanCompileResult`, `PlanFacts`, `planTabs`, `PLAN_DISPLAYS`, `AppPlan`,
  `PlanDisplay`, `PlanGroup`, `PlanLeaf`, `PlanQuery`, `PlanServer`, and the
  island-derived-values surface. `checkBindingShapes` and `BindingShapeError` stay
  — they moved to `genui/shape-check.ts` and still serve the screen's
  bindings-fit check. `evaluateExpr` and the brace grammar stay: the renderer
  evaluates them.

  Renamed, because "wire" no longer names anything: `KIT_WIRE_UNSAFE_NAMES` is
  `KIT_NON_SCREEN_NAMES` and `KIT_WIRE_COMPONENT_NAMES` is
  `KIT_SCREEN_COMPONENT_NAMES`. The `WIRE_COMPONENT_NAMES` alias is deleted.

  Removed from `@vendoai/apps`: `skeletonFromPlan`, `checkoutApp`,
  `AppsRuntime.authored` (`authoredScreen` is the screen's counterpart and stays),
  `AppsConfig.escalatedPlan`, `create({plan})`, `RenderSeamOptions.authoredApp`,
  `RenderSeamOptions.facts`, `AppFloor.compile` and `AppFloor.check` — the floor
  has one method, `component()`. `HOT_PATH_FILES` is `["app.tsx"]`, so the render
  seam watches, checks and paints exactly one file. `validateWrittenApps` no longer
  takes a `workspace` and no longer has a `{document}` door — a screen's mechanical
  half already ran as its paint gate, so the gate's one call is `validate({appId})`
  — and the `validate` verb itself takes `{ appId }` only.

  Escalation stays and is re-shaped. The screen agent's `escalate` hand takes one
  plain sentence — why assembly cannot serve this ask — and the builder is handed
  the person's ORIGINAL prompt beside it. Nothing pre-plans the build and nothing
  pre-declares the box's interface. The cost is the instant outline: an escalated
  build now shows a plain building state until the box has something real to show.

  Two consequences of the plan's removal, both visible to a host:

  - A box that reported no interface is now a FAILED create/edit rather than a
    warning. It used to be reported only for a plan that required a served
    surface, because a layer-2 failure still left the plan's skeleton standing —
    and there is no skeleton now, so a silent success would be an empty app
    declared ready.
  - The 2→3 served-surface flip has no trigger left. `<Server served>` was its
    only source, so an app can no longer BECOME a served app; everything about one
    that already is (`ui: "http"`) — the serve door, ping, fork refusal, box-path
    edits — is untouched.

- 37ed821: Per-user limits: Vendo counts, the host decides.

  `createVendo({ limits })` takes one callback, asked once before each metered
  action — a user message, an app generation — with the resolved user, the action,
  and a `count(action, window?)` reader already bound to THAT user. Return `false`,
  or `{ allow: false, message }` to say why in your own words, and the action is
  refused and never counted; anything else allows it and the meter records it.

  ```ts
  createVendo({
    limits: async ({ user, action, count }) =>
      user.facts?.plan === "pro" || (await count(action, { days: 1 })) < 20,
  });
  ```

  `count` is a callback and not a number because most policies read the meter
  once, for one window, and pre-computing every window a policy might ask about
  would be a query per action per call. `window` ANDs `days`/`hours`/`minutes`
  into one lookback, or takes a `since` instant, or names a `pool`.

  **Pools** are the shared meters a user's usage ALSO counts into — a seat pool, a
  team, an org. The auth preset grows a `pools` seam beside `facts`, resolved off
  the same session decode, and its answer rides `ctx.pools` to the policy;
  `count(action, { pool: "workspace" })` then counts the whole bucket rather than
  the one person, and an allow accrues to every pool the user is in. Counting a
  pool the user is NOT in throws rather than answering `0` — a zero from a meter
  that was never resolved silently under-counts every limit written against it.

  **A denied message costs nothing.** The message choke sits at turn entry, before
  the thread is resolved, so a refused message performs no read, no write and no
  model call. The turn's whole response is the limit card.

  **A denied generation lets the turn carry on.** The generation choke wraps
  `vendo_make`, the one door an app is built through, and answers the agent with
  the same `blocked` outcome every other refusal on that registry uses — so the
  agent can say what happened in its own words — while raising the card the person
  reads on the call's own stream.

  A refusal nobody was asked about — a limit, a guard rule, an unattended park, a
  guard that could not run its check — now settles on the wire as that typed
  `blocked` outcome rather than as the ai-SDK's `output-denied`. That state is the
  terminal state of an approval a PERSON turned down: its provider conversion takes
  the refusal's words off the part's `approval`, so a refusal that has none used to
  write history that could not be sent again, and the thread died on the turn after
  one — including an unattended thread whose call is waiting on a standing grant.
  The refusal's own words are now kept in the record too, and the beat says who
  refused: "wasn't allowed", not "you declined it". A person's actual no is
  unchanged, and is the only thing `output-denied` now means.

  Both raise `data-vendo-limit`, and the chat surface renders it as a card in the
  beat's ordinary muted register: a cap reached is not a failure, so no ✕, no
  danger colour, and a polite `status` rather than an `alert`. The host's own
  sentence is what the person reads when the policy wrote one — the host set the
  cap, so only the host can say what it is or when it lifts — and a policy that
  said nothing gets the chrome's line, which claims only that the request never
  ran.

  **A policy that throws DENIES**, and logs `limits.callback_error`. A limits
  system that fails open stops limiting silently, so the host keeps believing they
  have a cap while every user is unlimited — strictly worse than a turn that was
  refused and said so.

  **A `limits` policy against a store with no usage meter is refused at
  composition.** `StoreOps.usage` is optional, and a store that cannot count reads
  every user as zero, so no limit would ever be reached and every user would be
  unlimited. It throws where the deployment is built rather than enforcing against
  counts that are all zero.

  `vendo.usage(query)` is the operator's read of the same meter — per subject and
  action, over one window — for a host's own backend job: an overage sweep, a
  usage table. A policy never uses it; a policy asks its own bound `count` and
  never names a subject. On a meterless store it refuses for the same reason
  `emit` does, because a billing sweep reading "no usage" would bill nobody.

  Unset, `limits` wires nothing: no limiter is composed, the tool registry is the
  same object it always was, and each choke point costs one `undefined` check.

### Patch Changes

- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [46aee4a]
- Updated dependencies [83aec51]
- Updated dependencies [01e225c]
- Updated dependencies [d9b7c8d]
- Updated dependencies [5932631]
- Updated dependencies [491a2fa]
- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [37ed821]
- Updated dependencies [6856b4f]
- Updated dependencies [730ac8f]
  - @vendoai/apps@0.21.0
  - @vendoai/core@0.21.0
  - @vendoai/guard@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [095f143]
- Updated dependencies [7fcf60b]
- Updated dependencies [cfd4f48]
  - @vendoai/core@0.20.0
  - @vendoai/apps@0.20.0
  - @vendoai/guard@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [2879e46]
- Updated dependencies [39a1c78]
- Updated dependencies [5f4d694]
  - @vendoai/core@0.19.0
  - @vendoai/apps@0.19.0
  - @vendoai/guard@0.19.0

## 0.18.0

### Patch Changes

- 88ec7e6: Appending a message to a hosted thread stops downloading the whole conversation first. The wire had no verb that carried an owner, so the client read `data.subject` off the thread record before it could write — a turn paid that read several times, and the payload grew with the conversation forever, while the SQL half had always done the same work in one statement. `transcripts.appendMessages` is the additive 36th op (body `{threadId, subject, messages, title?}`, answer `{revision, count}`, deliberately NOT the thread — echoing the transcript back would reintroduce exactly the payload the op removes), `StoreOps.appendMessages` is its optional client method, and a turn's changed messages now go out as ONE `upsertMany`. `Thread.revision` is carried from the read so persist compare-and-swaps on it instead of re-reading, and persist runs only when the row must be created — every later turn is a pure append, title and all.

  A console that predates the op is served by an explicit capability feature-detect (the `/status` op count, the wire's own discovery handshake) asked once per StoreOps handle and cached, which routes to the older getThread + putMessage path. It is a supported route chosen BEFORE the write, never a catch-and-degrade around a failed mutation (#1251), and the count is a proxy for capability only while ops are ONLY EVER ADDED — remove one while adding another and a mount reaches 36 without serving this op, which is named in the comment for whoever adds op 37.

  Every transcript writer now takes the thread row BEFORE allocating a `seq`. `seq` carries conversation order and has no unique constraint, so equal seqs make the transcript read back ordered by message id — scrambled. Two concurrent writers used to read `max(seq) + 1` from their own READ COMMITTED snapshots before anything held a lock: on real PostgreSQL 17.11, 20 rounds of each pairing collided 19–20 times out of 20. `touchThread` runs first in `appendMessages`, `putMessage` and `recordAnswer` alike, so the loser blocks on the thread row until the winner COMMITs and allocates on a snapshot that already holds its rows; `upsertMany` and `appendThreadMessages` therefore take NO caller seq, because a position computed outside the transaction cannot be made safe. One lock order everywhere also means none of these writers can deadlock against another. The race test runs all three pairings on the postgres leg — PGlite is one connection and nothing interleaves, so it can never catch this.

- Updated dependencies [88ec7e6]
- Updated dependencies [88ec7e6]
  - @vendoai/core@0.18.0
  - @vendoai/guard@0.18.0
  - @vendoai/apps@0.18.0

## 0.17.0

### Patch Changes

- 8ded5cc: The automation ask stops falling into the two-step trap. The `schedule` verb's words matched its behavior nowhere: titled "Set when this runs" and described as "Set or change … what you are arming", it taught calling agents to build a view with `vendo_make` and then arm it here — but the verb only re-times an EXISTING automation, so the ask died with a refusal and no automation was ever authored (field: every scheduled-task ask on the linkwarden baseline). Now the verb says the one thing it does — retitled "Change when this runs", described as never creating, naming `vendo_make` (this app in `app`, schedule and action in one request) as the authoring door — and the no-trigger refusal carries the same exact next move so a mid-turn agent can recover. The screen agent's escalate door also names away work explicitly ("any part that must run while nobody is watching — a schedule, a product event — … escalate the WHOLE ask"), closing the gap where its skill taught the `<Server>` declaration but the door's own text listed only real-code reasons to leave, so a schedule ask got assembled as a plain view with no trigger. The MCP app shim is regenerated for the retitle.
- 8af9e4c: A deployment's users can use the product over text message. `createVendo({ channels: { text: true } })` plus one anchor to `/api/vendo/channels/text/link` is the whole opt-in: a signed-in user opens the anchor, their phone jumps into a prefilled first message, and from then on they text the agent, which acts as them exactly as it does in a web chat — same guard, same threads, same audit. Linking takes two texts because the identity router that binds the phone consumes the first one, so the link page says so and the code is short and unambiguous enough to retype. The phone ↔ user binding lives in the deployment's own store (`vendo_channel_links`, swept by `erase.bySubject`); Vendo Cloud carries the numbers and the delivery and never learns who a phone belongs to. A gated tool call parks as usual and the consent card becomes a text carrying the exact action and arguments — "YES" from the linked phone decides the same approval record the turn is blocked on, so an approval wait is now a per-turn bound (10 minutes on a channel turn, the frozen 90 seconds everywhere else).
- Updated dependencies [c17d492]
- Updated dependencies [64004b6]
- Updated dependencies [85fc732]
- Updated dependencies [729dd3e]
- Updated dependencies [9ea21ef]
- Updated dependencies [1865bdd]
- Updated dependencies [c79866f]
- Updated dependencies [8ded5cc]
  - @vendoai/core@0.17.0
  - @vendoai/apps@0.17.0
  - @vendoai/guard@0.17.0

## 0.16.0

### Patch Changes

- @vendoai/core@0.16.0
- @vendoai/guard@0.16.0

## 0.15.0

### Minor Changes

- b324b79: **Breaking.** Third-party provider keys no longer select adapters. Pass the
  adapter explicitly (`vendo init` now writes it for you) or set `VENDO_API_KEY`.

  Env keys are credentials; config selects. A key lying around in the environment
  used to choose which sandbox a deployment ran on, which provider it billed, and
  which account every app machine's inference went to — decided by nothing anyone
  wrote down. `VENDO_API_KEY` is now the only environment variable that fills an
  adapter slot you left unset. Every ladder reads the same way: explicit config,
  then `VENDO_API_KEY`, then an honest failure that names both ways out.

  - **Sandbox.** `E2B_API_KEY` no longer selects the e2b venue. It is the
    credential an explicit `sandbox: e2bSandbox()` reads when you pass no inline
    `apiKey`, and `e2bSandbox()` now refuses at boot — rather than at the first
    box build — when the optional `e2b` package does not resolve from the project.
    An unset `sandbox` slot composes the Cloud sandbox with `VENDO_API_KEY`, or
    nothing. `selectSandbox` drops its e2b rung and its `e2bSpecifier` parameter;
    the `"e2b"` venue string stays in the `/status` union for older wires, but an
    explicit adapter reports `"custom"` like any other.
  - **Agent model.** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
    `GOOGLE_GENERATIVE_AI_API_KEY` select nothing. They are read by the
    `@ai-sdk/*` provider you construct and pass in `models`. With no `models` and
    no `VENDO_API_KEY`, the first turn says exactly that instead of quietly riding
    a key you set for something else.
  - **Box inference.** The `VENDO_INFERENCE_URL` + `VENDO_INFERENCE_KEY` pair wins
    as a pair — both halves or neither — then `VENDO_API_KEY` rides the Cloud
    gateway, then the box gets no inference door. The `ANTHROPIC_API_KEY` rung is
    gone from both `boxInference()` and the Claude Code harness's
    `inferenceEnv()`: a provider key in the deployment's environment used to point
    every box at `api.anthropic.com` and bill that account.
  - **Doctor.** `E-LIVE-007` is retired — with no key-selected venue there is no
    such thing as a venue the operator did not ask for, and the boot refusal is
    earlier and louder than a probe. The code stays in the append-only registry
    and keeps its verify-page anchor. `E-LIVE-004` now names the two ways out.

  `VENDO_DEV_CREDENTIAL` still pins a credential rung, and is now the only way to
  reach an `env-key` rung at all — but it is internal, Vendo's own E2E rung matrix
  and escape hatch, not a host knob, and it can change without notice. Your app's
  model belongs in `models`.

- 8f00291: The selection law leaves a way out: the migration surface for "env keys are
  credentials, config selects".

  `vendo init` writes the `models:` line again. It resolved the key through the
  runtime credential ladder, which by design stopped answering for a bare provider
  key — so the one thing that turns a host's existing key into explicit config
  became unreachable, and the detection now reads the environment directly. The
  `--byo` paste is covered too: that key arrives during the cloud step, after the
  composition was planned and before anything is written, so the run re-renders
  the composition it authored instead of saving a key that selects nothing. The
  closing summary no longer advises setting a model key on a run that just wrote
  one.

  The provider init writes an import for is the provider it installs. `ensureProviderDeps`
  asked the runtime credential which `@ai-sdk/*` package the host needs, and a bare
  provider key is `rung: "none"` — so a fresh host with only `OPENAI_API_KEY` (or a
  Google key) had an `@ai-sdk/openai` import written into its route and nothing
  installed to satisfy it, and the app could not build. It now covers both answers:
  what a runtime turn loads, and what this run actually wrote.

  `vendo sync --ai` stops telling a developer to set the key they already set. Its
  credential gate ran on the runtime resolver alone, so a machine whose only
  credential is `ANTHROPIC_API_KEY` was told "set ANTHROPIC_API_KEY" while the
  harnesses that authenticate with exactly that key were never probed. The gate now
  also reads the provider keys a rung runs on, which is what makes the message
  honest: it can only be reached when every credential it names is genuinely
  absent.

  `claudeCode({ machine: "local" })` fails loudly with no model. That machine
  REPLACES the subprocess environment, so a deployment whose only credential was a
  provider key now hands the session nothing — intended, but it used to die deep
  inside the SDK. It names both ways out, explicit endpoint first: the
  `VENDO_INFERENCE_URL` + `VENDO_INFERENCE_KEY` pair, or `VENDO_API_KEY` for the
  Cloud gateway.

  The `mastra-agent` example composes its models explicitly instead of expecting
  the environment to pick one, and the docs that still described env-resolved
  selection say what the code does.

### Patch Changes

- Updated dependencies [b57df06]
  - @vendoai/core@0.15.0
  - @vendoai/guard@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [954ad09]
  - @vendoai/core@0.14.0
  - @vendoai/guard@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [395fc1e]
- Updated dependencies [9034bcc]
- Updated dependencies [031195f]
  - @vendoai/core@0.13.0
  - @vendoai/guard@0.13.0

## 0.12.0

### Patch Changes

- @vendoai/core@0.12.0
- @vendoai/guard@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [5c8043d]
- Updated dependencies [e58520e]
- Updated dependencies [863dc53]
  - @vendoai/core@0.11.0
  - @vendoai/guard@0.11.0

## 0.10.0

### Minor Changes

- d9ae728: One Claude Code integration, and automation authoring gets its own door

  The box carried **two** Claude Agent SDK loops: the conversational session door
  (`claude-turn.mjs`, the same module `machine: "local"` runs on a host) and a
  bespoke one-shot runner behind `/agent/task`. The duplicate is deleted. The
  supervisor's task door now drives the SAME `claude-turn.mjs` the session door
  does — one runner, two doors, three callers — keeping what only the task door
  needs: the box conventions the agent builds against, and the structured result
  the host polls for.

  **Box boundary — the one behavioral change.** That structured result now arrives
  as a FILE: the agent writes `/app/.vendo/report.json` and the supervisor reads
  it back, where it used to call an in-process `report_done` MCP tool. The shared
  runner's only MCP server is the host's own door, and a box task has none, so
  the report rides the one channel a box task and its supervisor already share.
  The JSON is the same shape it always was (`ok`, `summary`, `filesChanged`,
  `testsRun`, `fns?`, `servesUi?`) and it is still treated as DATA host-side —
  nothing in it can approve or authorize anything. **If you maintain a custom box
  image or your own in-box agent, this is the line to change**: end the task by
  writing that file instead of calling a tool. **The control-port protocol itself
  did not change** — `/agent/task` still answers `202 {taskId}` and
  `/agent/task/<id>` still answers `{status, result?, log}`, so nothing outside
  the box needed edits.

  Escalation now means exactly two rungs: the screen agent, and the box.
  Authoring an automation never needed a machine, so it is its own door:

  ```ts
  await apps.automation.author(
    {
      appId,
      instruction: "email me the unpaid invoices every Friday",
      mode: "steps",
    },
    ctx
  );
  // → { ok: true, document, triggerId, armed } | { ok: false, issues }
  ```

  The planner, the trigger-id rules, the results-board rewire and the arming are
  **unchanged** — `planAutomation` and its lane moved from
  `generation/lanes.ts` to `server/automation/{plan,lane}.ts` verbatim. An
  escalated plan that asks for an automation is routed to the same door, so both
  ways in land, arm and audit identically.

  **`<Server kind="steps">` and `<Server kind="agentic">` both still exist and
  still work — nothing was removed from the plan dialect.** What changed is where
  they lead: they are no longer _escalation kinds_ (branches of the server lane
  that could reach for a machine), they are the escalating agent's signal INTO
  the automation door. A plan that declares either authors exactly the automation
  it always did. `steps` remains the deterministic mode — a fixed step pipeline
  with no model call per firing — and `agentic` the judgment-per-run mode. Only
  `kind="box"` still means a machine, and it is now the only rung the ladder has.

  **Behavior fix:** `create` and `edit` no longer disagree about escalation.
  `create` used to refuse EVERY escalation on a deployment with no sandbox while
  `edit` refused only a box — so an automation you could ask for by editing an
  app you could not ask for by making one. Both now gate on the one expression
  (`escalationNeedsMachine`), and only the box rung needs a machine.

  **Migration:** `AppsRuntime` gains a required `automation` slot (a test double
  implementing the interface by hand must add it). No import path changed.

- ed44a58: A dev-only workbench diagnostics channel behind `VENDO_WORKBENCH`, and the feed
  store that reads it.

  `@vendoai/harnesses` reports what a turn is doing about itself — step starts and
  ends, guarded tool calls, context and compaction, loadout, hires, errors — on a
  transient `data-vendo-debug` part. The gate is `VENDO_WORKBENCH=1` on the
  server, read once per turn: unset, no channel is registered, so nothing can
  reach the wire and nothing is ever persisted.

  `@vendoai/ui` gains the receiving half: `publishWorkbenchPart` files a chunk,
  `useWorkbenchFeed` reads the turns back in the producer's own `seq` order, and
  `developmentMode` decides whether such a surface renders at all.
  `@vendoai/vendo/react` re-exports all three, so a host on the umbrella package
  can build the pane without reaching for `@vendoai/ui` directly.

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
  - @vendoai/guard@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [18c77cd]
  - @vendoai/core@0.9.0
  - @vendoai/apps@0.9.0
  - @vendoai/guard@0.9.0

## 0.8.1

### Patch Changes

- d599d23: `.vendo/tools.json` is the one source of truth for every tool's request and
  response schema, and the runtime sampler is gone.

  Sync fills both slots through a trust ladder and records which rung filled each
  one: the host's own spec (`declared`), its TypeScript types (`types`), the AI
  judge reading the handler (`inferred`), or nothing (`unknown`). The judge may
  only fill a slot nothing else could read — refused in code, not by prompt — and
  its fills survive the next sync through the same carry-over `semantics` uses.
  Coverage is reported plainly by `vendo sync`.

  Every prompt that lists tools now lists all of them: a tool with a declared
  schema shows its shape, and a tool with a blind slot says so in words. A blind
  input never prints as `{}`, which reads as "takes no arguments" — and a
  declared no-argument tool still prints the empty schema it really has.

  **Breaking, both pre-1.0:**

  - `AppsConfig.connectedToolkits` is removed from `@vendoai/apps`. Its only
    reader was the create-time shape sampler, which is deleted: nothing calls the
    host to learn a shape anymore. Drop the option; there is no replacement and
    nothing to migrate.
  - `deriveShapeCard`, `deriveShape`, `mergeShapes`, `ShapeCard` and
    `shapeCardSchema` are removed from `@vendoai/core`. Shapes come from declared
    JSON Schema now — use `shapeFromJsonSchema(schema)`, which additionally keeps
    `enum` values a sample always erased.

  A host that declares its response schemas gets strictly better checking and one
  fewer live call per create. A host that declares nothing keeps working: blind
  tools run permissively, and the report says which ones they are.

- 7163a25: Every finished screen faces the AI reviewer, with the data it renders.

  A bills dashboard summed two overlapping query results into one headline: $11,216
  on screen over ~$6,276 of real bills (demo-bank, 2026-08-06). Every mechanical
  check passed, because a double count is not a shape error — the binding was well
  typed, the field existed, the tool was real. The reviewer is the only check that
  can see it, and it never ran: it fired only when the writing model volunteered to
  call `validate({appId})`, and that run did not.

  Two things change.

  **The reviewer is no longer optional.** It runs at both places a screen is
  finished — when the screen agent's assembly completes with a stored, painted app,
  and at the built path's turn boundary where the validate gate already runs. Its
  findings join the existing single repair round; there are no loops, and the
  reviewer's own fail-open posture is untouched — silence, a refusal and a failed
  request still all mean no findings, so a reviewer that could not judge never costs
  a person their screen. It is deliberately still absent from the paint seam, which
  runs on every save, and it is never spent on a document that did not pass the
  mechanical floor or never reached the screen.

  **The reviewer now sees the rows.** `validate({appId})` runs the app's own
  `<Query>` tools — read risk only, through the same guard-bound registry the screen
  itself reads from — and hands the results to the reviewer beside the printed
  markup. Its rubric gained one rule: check every total, count and average against
  those rows, including the overlap case where two queries return the same records
  and both get summed.

  The cost is exactly one reviewer model call per finished screen.

- 12a344c: The screen agent ships one door, and the tool bridge stops currying for a caller
  that no longer exists.

  `screenAgent()` is removed from `@vendoai/harnesses`. The file shipped two doors
  into one assembly loop, and only `screenAssembler()` — the `vendo_make` route
  composition fills — was ever wired. The unused door had already drifted from the
  live one: it never passed `design`, so a screen assembled through it lost the
  host's theme brief, and it passed `turn.system` straight through, the
  conversational prompt the live door deliberately withholds from a writer loop. A
  door that nothing calls cannot be found wrong by anything, so it silently became
  the wrong door. `assembleScreen`, `screenAssembler`, `escalatedPlanPath`,
  `ScreenSurface`, `ScreenInput`, `ScreenResult` and the three tool-name constants
  are unchanged and still exported.

  Inside the package, `buildAgentTools` and `addAgentTool` are gone with it. They
  built an ai-SDK `ToolSet` for a path this repo stopped taking — the harness
  runtime calls the bridge directly, and `find_tools` builds its own tool — and
  their existence was the entire reason `guardedCall` and `previewApproval` were
  curried factories rather than plain functions. Both now take the call arguments
  directly (`guardedCall(descriptor, options, input, { toolCallId })`,
  `previewApproval(descriptor, options, input, { toolCallId }, onAsk?)`); both live
  callers invoked the returned closure on the very next expression, so this is
  behaviour-neutral. `onAsk` is unchanged, and neither function was ever on the
  barrel.

- 0f6455a: Stop reaches a sandboxed session immediately, not up to ten seconds later.

  The box driver only noticed `turn.signal` between polls, and the box door holds a
  poll open for ten seconds when the session has nothing to say. So Stop pressed
  during a long tool call — the moment a user actually reaches for it — sat behind
  that parked poll before the interrupt was sent. The driver now interrupts from an
  `abort` listener the instant the signal fires, matching the local (non-sandboxed)
  path, which has always done it this way.

- 5e584c8: `claudeCode({ machine: "local" })` now bounds a message the way the sandbox path
  always has. A live session's turn ends on a `result`, and a `result` that never
  arrives — an interrupted session, or a mid-build steer the model folded into the
  turn already running — used to leave `send()` pending forever. Because
  `ClaudeSession` answers pushed messages strictly in order, that took the whole
  thread with it: the user's next message waited behind a turn that had already
  silently lost, for the life of the process.

  Both rungs now share one `MESSAGE_BUDGET_MS`. On the local rung a breach
  interrupts the turn, drops the session, and throws — the disk stays warm, so the
  next message opens a fresh session that resumes rather than a cold start.

- a621123: Two checks stop reporting a verdict they never reached.

  `vendo doctor`'s render probe GETs the app origin's `/` and never reads the body, so a
  status line is the whole observation. It failed on 5xx and blessed everything else as
  "the app's root page renders" — which made `ok: the app's root page renders (HTTP 404)`
  the line every healthy run printed, on the one status that means the server is saying
  there is no page here.

  A 5xx still fails `E-LIVE-006` unchanged; that is the crashing-site case the gate exists
  for. A 4xx is now a note that names the status and says no page was reached, because a
  host serving nothing at `/` — every page under a basePath, an auth layer in front — is
  healthy, and doctor cannot tell that from a route you meant to have. That is the same
  judgement the probe's own unreachable-origin branch already declines to make. A 2xx
  passes as "answered HTTP 200": true, and the most this probe can know.

  In the screen agent, a save that landed bytes the render seam would not paint was told
  "validate found nothing to fix". `validateWrittenApps` is fail-open by design and returns
  no failures both when validate passed and for every way it could not reach a verdict — a
  guard that denied the call, an answer it cannot parse, a workspace that closed under it,
  each reported to the operator only. The hand cannot tell those apart, so it no longer
  claims to: it states the failed paint, which is the fact it has. When the gate did produce
  findings, the note is still the repair instruction verbatim.

- Updated dependencies [a7a0fcf]
- Updated dependencies [2ab4a39]
- Updated dependencies [38b32a3]
- Updated dependencies [e092567]
- Updated dependencies [2fd14aa]
- Updated dependencies [898eb8f]
- Updated dependencies [b99147f]
- Updated dependencies [46923cc]
- Updated dependencies [b50a766]
- Updated dependencies [f25138f]
- Updated dependencies [022f789]
- Updated dependencies [354f231]
- Updated dependencies [ee92750]
- Updated dependencies [d599d23]
- Updated dependencies [a69aa5c]
- Updated dependencies [89660d1]
- Updated dependencies [7163a25]
- Updated dependencies [1022b2f]
- Updated dependencies [2b6d60f]
- Updated dependencies [b99147f]
- Updated dependencies [b99147f]
- Updated dependencies [5e8a141]
- Updated dependencies [8f3d23a]
- Updated dependencies [be9f3e9]
- Updated dependencies [2b49b64]
- Updated dependencies [2b49b64]
- Updated dependencies [6fb568a]
- Updated dependencies [2357b22]
  - @vendoai/core@0.8.1
  - @vendoai/guard@0.8.1
  - @vendoai/apps@0.8.1

## 0.8.0

### Minor Changes

- 1572060: An app's code reaches the store, so the box is disposable.

  `AppDocument.source` and the `checkoutApp`/`commitApp` seam landed with the
  contract but with ZERO production callers: every build still persisted code only
  into the sandbox snapshot behind `machine.snapshotRef`, so losing a snapshot lost
  the customer's app. This wires the commit half in.

  - `RenderSeamOptions.commitSource` is the sibling of `authoredApp` on the SAME
    interception point. `commit()` is the store-write moment, and the reason is the
    one already stated in `render-seam.ts`: the sandbox sync-back path commits
    without ever calling `writeFile` on this façade, so a builder working inside a
    box reaches the store here and nowhere else. It runs once per APP a commit
    touched, with `CommitResult.changed` verbatim; a `conflict` result persists
    nothing, because nothing landed.
  - `AppsRuntime.commitSource` is the store half, binding `commitApp` to the app
    row's ownership (§9.7 — the address comes from the owner, never from which
    mount happens to be writable), its compare-and-swap update, and — new —
    `AppsConfig.files`, the SAME `FilesAdapter` the workspace rows spill to.
  - The `HOT_PATH` regex became one `APP_PATH` regex with the filename as a tail,
    so "which app is this path in?" has one answer for the hot paths and the source
    tree alike. No second path reader.
  - Source persistence can never fail the commit it rides on, exactly as a view
    cannot — but a silently dropped source file is a lost app, so a failure is
    logged loudly rather than swallowed.

  `machine.snapshotRef` is now a cache in fact and not only in the doc comment: the
  audit found no reader of it anywhere that recovers source (`SandboxMachine` has no
  file-read method at all), and the new seam test deletes an app's snapshot, proves
  `resume` fails, and rebuilds the app from its row alone into a store that has
  never held its files — byte for byte, including a file past the inline cap so the
  blob-spill leg is proven too. `trigger`, `placements`, grants and the app's id all
  ride through untouched: a commit is not a generation.

  Two things that ride along, because this PR is `commitApp`'s first real caller and
  both only become reachable with one:

  - **`commitSource` is a new authorization surface, so it is tested hostilely.** The
    appId it writes to is derived from the COMMITTED PATHS, and a caller may write
    anything under their own `/user` mount — including another person's app
    directory. Three cases are now pinned: a foreign caller is refused and the
    refusal is AUDIBLE rather than a silent skip; an org-owned app resolves to its
    ORG address even when the caller's personal mount is writable too; and a commit
    naming a stranger's app alongside the caller's own lands nothing on the
    stranger's while still landing the caller's. All three pass against the gates
    Phase 0 already put in — these document them, they do not add them.
  - **"Would not read" is no longer treated as "was deleted."** `commitApp` decided
    deletions by whether the read-back threw, and for a spilled file that read is a
    live fetch from the files adapter — so a blob store having a bad minute looked
    exactly like a deletion and the entry was dropped. Now a path that still EXISTS
    but will not read keeps its stored entry and says so loudly; only a confirmed
    absence is a deletion. Per path, so the rest of the commit still lands.

- 1bb535b: The checks floor moves to the paint seam, and `instant()` is removed.

  ## BREAKING: `instant()` is gone

  `instant()`, `InstantHarnessDeps` and `InstantHarnessOptions` are removed from
  `@vendoai/harnesses` and from the `@vendoai/vendo/server` re-export. Two engines
  and no third: the lean `vendo()` loop, and the builder on the claude-code
  runtime.

  The specialist existed to put a layout on screen in seconds by routing an app ask
  straight at the guarded engine tool. The paint seam now does exactly that for
  **every** harness — a plan file renders its skeleton the moment it parses,
  whoever wrote it — so its whole reason for being was absorbed by the thing every
  thinker already rides.

  **If you had `harness: instant()`:** delete it. The slot's default is `vendo()`,
  which is the same guard, the same audit trail, the same view channel, and the
  same skeleton-in-seconds behaviour.

  ```diff
  - import { createVendo, instant } from "@vendoai/vendo/server";
  + import { createVendo } from "@vendoai/vendo/server";

    export const vendo = createVendo({
  -   harness: instant(),
      auth: { ... },
    });
  ```

  ## The checks floor runs on every commit, for every author

  The render seam compiled `app.vendo` with `compileWire(content)` and **no
  options**, so it spoke a different dialect than every other compile of model
  wire. Measured, both directions:

  - a lying binding — a `$path` naming a field the tool's response shape does not
    have — compiled to `issues: []` and `bindingErrors: []`. "The engine's
    unshippable gate" was structurally dead on the files-first path, and the app
    painted a label promising a number it could never show.
  - an app built on inline tool references had its binding **dropped** and its
    query never minted, and painted anyway, because the tree kept its children.

  So nothing checked a harness's own writes. The floor was live for the built-in
  conductor and structurally dead for every other author — a builder writing
  `app.vendo` with its own hands, a human with an editor.

  Now composition injects the floor into the seam (`RenderSeamOptions.floor`, built
  from the new `AppsRuntime.floor(ctx)`). Every commit to `app.vendo` compiles in
  the production dialect and runs the seven deterministic fact checks plus whatever
  the host plugged in through a pack. A blocking finding means the view does not
  paint — through the seam's existing "emits nothing, the last good view stays"
  mechanism, not a new failure channel — and the write still lands, so `validate`
  can read it back and repair it.

  Hosts need no code change for this: the seam is wired in composition.

  ## `validate` runs the whole floor, and the builder must pass it

  `AppsRuntime.validate` built its layer from `config.checks` alone, so it ran the
  fact checks and skipped the AI reviewer. The building-apps skill teaches
  "validate after every edit", and what it taught could not see invented data,
  dishonest tool use, dead controls, dropped work, or a single one of the host's
  own judgment **rules**. The reviewer is now composed in, fail-open as everywhere
  else: silence, a refusal, and a failed request all mean no findings.

  The claude-code harness's loop now requires it. After the turn's work reaches the
  store, the loop calls the same registered `validate` verb through
  `turn.tools.call` and, if an app document does not pass, hands the findings back
  for **one** bounded fix round. New exports for hosts driving their own harness
  loop: `validateWrittenApps`, `repairInstruction`, `VALIDATE_TOOL` from
  `@vendoai/harnesses`.

  ## `Finding` carries its check

  `Finding` gains an optional `check` naming the `Check` that produced it, stamped
  by the checking layer. Additive — existing readers are unaffected — but code that
  asserts exact `Finding` object equality will see the extra field. It makes
  architecture design §7's carve-out ("except host-check failures, which only the
  host can waive") representable for the first place: a built-in fact finding and a
  host's own plugged check were previously the same anonymous object.

  ## Also

  `@vendoai/core` gains the `AppFloor` port. The generation conductor is
  **quarantined** (`@deprecated`): its callers are frozen, not extended, and new
  work uses the lean loop with the floor at the seam.

- 56e0cc3: **BREAKING:** escalation gets its receiving end, and both experimental flags are
  deleted. `apps.experimentalScreenAgent` and `apps.experimentalMachines` are gone
  from `createVendo()`; passing either is now a type error.

  **The screen agent is THE engine.** Every `vendo_make` ask starts in the cheap
  assembly loop on every deployment. There is no flag and no coin-flip. The
  conductor is unchanged and is still what an `unavailable` answer, a broken
  assembler, or an `assembled` that left no app row falls through to.

  **Machine-backed execution is gated by the sandbox adapter, and nothing else.**
  Configure `createVendo({ sandbox })` and layer-2 boxes are reachable; leave it
  out and they are not. Presence IS the deliberate opt-in — no capability boolean
  beside it. Every read site moved: the box lane in `laneGates`, the box seam
  inside the generation pipeline, and `apps.machine.provision`, whose refusal now
  names the missing sandbox instead of a flag. Layer 3 is unchanged: a narrowing
  of layer 2 that additionally needs the mounted wire and `VENDO_BASE_URL`.

  **`escalate` now lands somewhere.** It used to fall through to the conductor with
  the plan discarded — which meant the person watched a skeleton, then watched an
  unrelated app replace it. Two answers now, and the deployment's own shape picks
  which:

  - **A sandbox is configured** → the build runs. The same `create` a
    server-needing ask has always taken, at the SAME app id, so the plan's skeleton
    and the finished app share one stream and the outline becomes the app in place.
  - **No sandbox** → a `failed` receipt whose `say` names the capability gap in the
    person's own terms. Not a fall-through: the conductor is assembly too, so it
    cannot serve what assembly just escalated, and trying would spend a whole
    build's latency to arrive at a worse version of the screen already on screen.
    The still-forming card is unmounted by the UI once the turn is over, so the
    receipt is the last word rather than a permanent shimmer.

  **The build anchors on the escalated plan.** `AppsRuntime.create` takes an
  additive `plan?: string` — the ask still travels verbatim and the plan rides
  beside it as the brief, so the brain builds the outline the person is watching
  rather than re-answering the ask from scratch. The plan is read back out of the
  app's workspace through a new adapter slot, `AppsConfig.escalatedPlan`, filled by
  composition for the same reason `AppsConfig.screen` is: `@vendoai/apps` holds no
  workspace. Unfilled, the build plans from the ask exactly as before.

  Additive surface: `AppsRuntime.machine.available()` (is a sandbox configured),
  and `escalatedPlanPath(appId)` from `@vendoai/harnesses` so the writing and the
  reading side cannot spell the plan's path two ways.

  **Migration:** delete `apps: { experimentalScreenAgent: true }` — it is the
  default now. Delete `apps: { experimentalMachines: true }` — if the deployment
  already passes a `sandbox`, machines stay on with no further change; if it does
  not, machines were never reachable anyway.

- b022eb3: Add `@vendoai/harnesses` — the runtime that runs any harness, plus `vendo()`.

  Who thinks becomes a swappable adapter. A harness receives a `Turn` (the
  canonical transcript, guarded tools, pack skills, the workspace, the model seats)
  and yields a closed four-member event vocabulary; the runtime does everything
  else, so a harness author cannot forget the safety story.

  New in `@vendoai/harnesses`:

  - `defineHarness(def)` — returns the value itself. A harness needing host
    dependencies is a plain factory closure; there is no factory concept.
  - `createHarnessRuntime(deps)` — builds the `Turn`, runs the harness, converts
    events plus mirrored tool calls into the EXISTING ai-SDK UIMessage stream with
    today's `data-vendo-*` parts, persists the transcript one row per message, and
    enforces the routing table (`text` → screen + transcript · `status` → screen
    only · `error` → screen + audit · `usage` → audit only). Tool calls are
    mirrored by the runtime, never yielded.
  - `vendo()` — the default in-process, key-free thinker. It DRIVES the shipped
    `@vendoai/agent` turn loop rather than reimplementing it, so the step cap,
    `buildFailedStop`, the history window, the cache breakpoints and the
    tool-search loadout are shared. Tools execute through `turn.tools.call()`,
    which runs the shipped guarded-call path — the guard, the audit row, the view
    channel and the transcript mirror included. It also hires its own bounded
    subagents; every hire is metered and leaves an audit row plus a receipt.
  - `assertHarnessComposable(harness, { sandbox })` — `requires: { sandbox }` is a
    boot-time composition error, never a runtime surprise.
  - The hot-path render seam: a commit that lands `app.vendo` or `plan.vendo` emits
    today's `data-vendo-view` part on the stable per-app stream id, so the skeleton
    reaches the screen whoever wrote the file. An unparseable or conflicted commit
    emits nothing and the last good view stays.
  - `turn.state` — opaque harness state, persisted at turn end, cleared by a
    harness swap or an arbitrary history edit.

  New in `@vendoai/core` (types only, so every block may speak them): `Harness`,
  `Turn`, `TurnTools`, `ToolResult`, `DeniedNeeds`, `ToolListing`, `TurnSkills`,
  `SkillListing`, `TurnState`, `HarnessEvent`, plus the two seams `Turn` is typed
  against — `WorkspaceFs`/`CommitResult` and `Seat`/`ResolvedModels`. `ai` and
  `just-bash` join core as OPTIONAL peer dependencies (type-only imports; hosts
  that do not touch these shapes install neither).

- c9df3f7: `instant()`, the default-route flip, and the consolidated `createVendo` surface.

  **`instant()` — the non-agentic specialist.** `@vendoai/harnesses` gains a
  second built-in thinker for hosts that want speed as the resident. One routing
  call sorts the ask into create / edit / act / cannot; an app ask goes STRAIGHT
  to the guarded apps tool, so the plan — which is the layout — reaches the screen
  while a resident thinker would still be forming its first sentence. Non-app asks
  act through the same guard door, capped at two steps so it is never a thinking
  loop. Genuinely impossible asks refuse in the consumer's voice. Every host
  effect goes through `turn.tools.call()`, so the guard, the audit row, the
  approval card, the view channel and the transcript mirror are unchanged — the
  specialist buys speed, never a second safety story.

  ```ts
  import { createVendo, instant } from "@vendoai/vendo/server";
  const vendo = createVendo({ auth: authJs(), harness: instant() });
  ```

  **`POST /threads` now runs through the harness runtime for every host** — the
  host's harness when they named one, `vendo()` when they did not. The rails that
  kept this opt-in (`find_tools`, the connection-scoped loadout, the curated menu,
  capability-miss detection) all reach the harness path, and the assembled system
  prompt rides the turn. Deployments whose store has no SQL handle (the Cloud
  hosted store, or a host's own non-SQL adapter) stay on the shipped agent path,
  because the transcript and workspace are tables.

  **The config surface is consolidated onto §10's eight slots** — `auth`, `tools`,
  `harness`, `packs`, `models`, `store`, `files`, `sandbox`. Additive only; no
  shipped host breaks:

  - NEW `tools:` — the host's own tool declarations in memory, the same
    `ExtractedTool[]` `vendo init` / `vendo sync` write to `.vendo/tools.json`.
    Precedence: `tools:` → `profile.tools` (now deprecated) → the file.
  - `model` → `models.default`, `paint` → `models.fill`, `profile.tools` →
    `tools:`. All three still work for one more minor and warn once, naming the
    move.
  - Every one of the 33 top-level keys has a stated destination, and the table is
    gated: a key added to the config without a documented destination fails a
    test.

  Also: the docs-rot gate on `handler-options.mdx` is real again. Its
  exhaustiveness assertion lived in a test file, which this package's tsconfig
  excludes from typecheck — so it never compiled and the documented key list sat
  ten keys behind the interface. The list moved into `src/config-keys.ts`, where
  both directions of the assertion actually run.

- 215bfcc: Harden the turn loop: one turn id everywhere, a token budget instead of a message
  count, a stated retry budget with ordered failover, an extensible stop array, and
  the supervisor slot.

  Every part of this is the shipped loop doing more, not a second loop beside it.

  - **Turn id on both routes.** `mintTurnId` had exactly one call site — the harness
    runtime — so a deployment whose store cannot serve harness turns (a host's own
    non-SQL adapter, the Cloud hosted store) wrote audit rows that named no turn.
    `createAgent` now mints on the same terms, onto the `RunContext` every guarded
    call and audit mint already holds. An id the caller already minted wins.
  - **Token-budgeted compaction.** `context.contextTokenBudget` bounds the PROMPT
    rather than the message count, shedding reasoning, then old tool payloads, then
    the oldest messages — via `pruneMessages`, which drops a tool call together with
    its result so the prompt stays well-formed however much it sheds. The size is a
    documented chars/4 estimate; `historyWindow` is unchanged.
  - **The knobs reach both thinkers.** `vendo()` built its context only when a
    `maxSteps` existed and put only `maxSteps` in it, so a host's `agent:` history
    window was silently ignored on the DEFAULT route. `VendoHarnessOptions` and
    `VendoHarnessDeps` now carry `historyWindow`, `contextTokenBudget` and
    `maxOutputTokens`, the whole context is passed, and `createVendo` forwards the
    host's `agent:` block to the harness it composes.
  - **Retries and failover.** `context.maxRetries` is explicit against
    `DEFAULT_MAX_RETRIES` (the SDK's own value, so nothing changed but ownership).
    `fallbacks` takes the rungs below the primary model and is tried in order when a
    provider fails BEFORE producing output; once output streams there is no
    failover, because a mid-stream switch would emit a second answer on top of half
    a first one. Cancellation is the only thing classified, and the last rung's error
    is rethrown untouched, so the wire error gate is unchanged.
  - **`stopWhen` is extensible.** `createAgent`'s `stopWhen` composes with the loop's
    own three conditions; `tokenBudgetStop(n)` is the shipped per-tenant ceiling and
    is exported publicly. Opt-in — unset, a turn runs exactly as it did.
  - **Supervisor slot, shipped as a no-op.** `createAgent`'s `supervise` gets the
    turn id, the final answer and the `RunContext`, and a refusal travels the failure
    path a turn already has (`wireErrorMessage`, the same `error` chunk, the same
    recorded notice). Unset costs a turn nothing.

- fbf265b: One front door: `vendo_make` replaces `vendo_apps_create` and `vendo_apps_edit`,
  and it hands back words instead of the app.

  **Breaking.** `vendo_apps_create` and `vendo_apps_edit` no longer exist. In their
  place is one tool with three parameters:

  ```ts
  {
    request: string,   // the ask, in the calling agent's own words — required
    app?: string,      // an existing AppId, to change that one specifically
    context?: string,  // free-text background, for callers whose conversation we cannot see
  }
  ```

  Two tools meant every calling agent — ours, a host's own AI SDK or Mastra agent,
  an outside agent over MCP — had to decide "new or change?" before it could ask,
  and get it right. That was never their decision: the seam knows whether an app
  exists, and a caller that wants a specific one says so with `app`. `context`
  exists because an outside agent's transcript is not ours to read; on our own
  doors the runtime's transcript stays authoritative and `context` is supplemental.

  **Also breaking: the tool returns a receipt, not the document.**

  ```ts
  interface MakeReceipt {
    id: AppId;
    title: string;
    status: "ready" | "building" | "failed";
    say: string; // ONE speakable line, consumer voice
  }
  ```

  The old tools returned the entire `AppDocument` — the tree, the island sources,
  the storage declarations, the machine reference. So a model was handed UI and
  trusted not to describe it, retell it, or invent from it. A model handed a tree
  eventually talks about the tree. Screens go server → slot; the agent only ever
  gets words, and `say` is the line it can utter verbatim. `status: "building"` is
  the honest answer while work continues.

  Two things follow from the receipt, and both are improvements rather than
  compromises. The automation card is now PUBLISHED by the apps runtime through the
  existing view-stream seam instead of being reconstructed at the agent bridge out
  of the edit tool's return value — one less part read by shape (01-core §16's own
  anti-smuggling rule, which that reconstruction was the exception to). And
  `instant()` now speaks the receipt's `say` rather than a canned "Updated.",
  which fixes a real mis-speak: a rejected change comes back OK, so the canned line
  claimed success for work that did not happen.

  **Migrating.** If you call the tool by name from your own agent, rename it and
  rename `prompt` → `request` and `appId` → `app`; drop `instruction` into
  `request`. If you read fields off its result, read `id` and `title` off the
  receipt and say `say`. If you had a policy rule or an override matching
  `vendo_apps_create` / `vendo_apps_edit` / `vendo_apps_*` for the build tools,
  match `vendo_make` — it deliberately sits OUTSIDE the `vendo_apps_` prefix,
  because it is the front door rather than a member of the runtime's family. Core
  exports `isVendoAppsTool(name)` for anything that needs to recognise both.

  Everything else about the call is unchanged: risk grade `read` (actions inside
  the screen are still graded and consented individually at call time), the view
  channel, the build-failed banner, and the transcript's build card.

- f7c6da2: Delete `@vendoai/agent`: one engine, one path, one home.

  The old `createAgent()` chat engine survived for one reason — hosted-store
  deployments could not serve harness turns, so they silently fell back to it.
  They can now, so the legacy path, its runner and `agent.stream` are gone and the
  harness runtime serves every turn. Nothing a client can see changes; the
  wire-parity suite is the proof.

  Breaking changes:

  - @vendoai/agent (whole package) → harnesses (runtime/loop/rails) + vendo
    (pack/prompt/threads)
  - createAgent/AgentConfig → createVendo harness path
  - VendoAgent type → none; HarnessTurns is the surface. Vendo.agent property →
    Vendo.harness
  - asRunner()/createRunner → awayRunner (composed internally for vendo_delegate)
  - supervise hook → dropped
  - memory-store fallback in the turn door → loud per-turn refusal
    (memoryStoreAdapter itself stays in core/conformance)
  - WireDeps.agent → WireDeps.harness (required)
  - Thread/ThreadSummary, tokenBudgetStop, ScriptedTurn, pack consts → new import
    homes (@vendoai/vendo, @vendoai/harnesses)
  - Behavior: vendo_delegate persists a thread + workspace per delegation (was
    stateless)
  - Behavior: POST /threads on a no-SQL/no-ops store → loud not-implemented error

  Also fixed on the way out: a failed turn whose harness threw (rather than
  reporting an `error` event) answered with one generic constant, so a keyless
  deployment was told "something went wrong" instead of to run `vendo login`, and
  nothing was persisted. Both runtime paths now pass the error through the same
  `wireErrorMessage` gate the legacy door used, and raise the same two carriers —
  the error chunk and the persisted `data-vendo-turn-error` part.

- 0197470: Reading a file off a sandbox is part of the seam, not each adapter's private
  business.

  `SandboxMachine.files` — `read`, `write`, `list` — is now declared on the public
  interface in `@vendoai/apps`. It already existed three times with an identical
  shape, hidden behind `satisfies SandboxMachine & Record<string, unknown> as
SandboxMachine` casts in the e2b and Vendo Cloud adapters and on the fake, and
  was missing entirely from two other test doubles: five private spellings (or
  absences) of one contract, on the seam a built app's SOURCE has to cross.

  The interface now states the answers all of them have to agree on:

  - `read` REJECTS for a path the box does not hold — never empty bytes, because a
    silently empty source file is a lost app.
  - `write` creates or replaces the whole file and creates the directories on the
    way to it. It never appends.
  - `list` is ONE level and names only: entries directly in `dir`, a subdirectory
    as its own name, never a path and never recursive. It rejects for a directory
    the box does not hold, exactly as `read` does.
  - `read` hands bytes back UNCHANGED — no text decode, no BOM strip, no
    line-ending normalization — because box content is untrusted and the layer
    above verifies it against the hash in the app's row.

  The shared conformance suite (`@vendoai/apps/adapter-conformance`) pins all of
  it in one leg that every adapter runs, so no provider can drift. Verified live
  against a real e2b sandbox, including a payload of NULs, bare CRs and invalid
  UTF-8.

  The consolidation paid for itself immediately: a review found that the
  in-memory `list` treated the root's prefix as `""` rather than `"/"`, so it
  sliced nothing off an absolute path and dropped every name as blank — `list("/")`
  answered `[]` on a box full of files. Before `inMemoryBoxFiles` that line existed
  in every fake that had a `list` and would have been a separate fix in each. It
  was one fix in one file, and the conformance suite now pins the root case for
  every implementation.

  Two further disagreements the promotion exposed, both invisible while `files` was
  private: the Vendo Cloud list route answers deeper than one level, so the Cloud
  adapter folds the depth away at the seam; and a missing directory rejected on
  real e2b (`[not_found] lstat …`) while both in-memory fakes answered `[]`,
  which is how a mistyped source directory reads as an app with no files. The
  seam now rejects everywhere.

  What went away: two redundant `files` casts on the real adapters, the
  `files`-shaped half of the Cloud wire test's private-surface cast, the
  `files` cast in three live bootstraps, and three copies of the fakes'
  in-memory file semantics (now one `inMemoryBoxFiles`). `SandboxMachineLike` in
  `@vendoai/harnesses/claude-code` carries `files`, still structurally and
  without widening the subpath's imports. `exec` stays adapter-private.

- 38dd824: The screen agent IS `vendo()`, and the checks floor rides the `vendo_make` route.

  ## `vendo()` takes a closed loadout

  `VendoHarnessDeps.tools` is new. Set, the equipped set is EXACTLY that list: a
  string equips that registry tool (guarded, through `turn.tools.call`, as today);
  a `HarnessHand` — `{ name, description, inputSchema, execute(input, turn) }` — is
  the harness's own hand, invisible to every other consumer. No discovery rail
  (`find_tools` is not mounted: a fixed loadout has nothing to discover), no
  `vendo_*` always-active exemption, no `hire_subagent` unless the list names it. A
  name the deployment's listing does not carry is simply not offered, because that
  list is written once at boot against a listing that legitimately varies per
  deployment.

  Unset — every existing caller — behaves exactly as before.

  `execute` receives the TURN, which is what lets a hand be declared where a
  `Harness` value is built (no run in sight) while its effects are per-run:
  `turn.workspace` is this run's files.

  ## The screen agent is configuration, not a second loop

  `screenAgent()` / `screenAssembler()` keep their doors, their brief, their
  `SCREEN_STEPS = 10` budget and their outcome semantics, but the bespoke
  `startTurn` drive underneath them is gone: they are now `vendo()` with a closed
  loadout and two hands (`save_app`, `escalate`). The step cap, the seat
  resolution, `wireErrorMessage`, the context knobs and the system precedence are
  the default harness's, so a rail cannot be fixed in one loop and stay broken in
  the other.

  ## Fixed: a screen assembled through `vendo_make` was never checked

  Composition wired the screen slot's render seam without the checks floor, while
  the harness-turn route passed `{ authoredApp, commitSource, floor }`. One seam,
  two answers: the same `app.vendo` — a binding naming a tool the host has not got,
  a prop the renderer drops — was refused on the harness route and painted on the
  `vendo_make` route, where it also compiled in the wrong dialect (no inline tool
  expansion, `bindingErrors: []` by construction) and never persisted its source.

  The screen slot now carries the same `floor` and `commitSource`. A blocking
  finding means nothing paints and the last good view stays, exactly as everywhere
  else; the write still lands, so `validate` can read it back and repair it. Hosts
  need no code change.

- 798b618: The screen agent: `vendo_make` starts in a cheap assembly loop, and the conductor
  is what it falls through to.

  Every request for something to look at used to go straight into the generation
  conductor — a plan call, a fill worker per group, and the checking layer's two fix
  rounds — whether the ask was a full app or one number on a card. Now the seam
  routes: a lean loop assembles the document itself, and escalates when it cannot.

  **The loop** (`screenAgent()` / `assembleScreen` in `@vendoai/harnesses`) is the
  same `startTurn` call `vendo()` and `instant()` drive, with a small loadout and a
  tight budget:

  - **Assembly tools only.** The verbs by name (`search_components`, `validate`,
    `vendo_apps_data_list`, `vendo_apps_open`, `ask_user`) unioned with the host's
    `read`-risk tools. No mutating host tool, no build tool, and `vendo_make` itself
    is withheld — the screen agent is what it calls.
  - **The host's own declared result shapes** ride the brief, off
    `ToolListing.outputSchema`, so field names are known before any query runs.
  - **The shipped job description**, reused: `buildingAppsSkill` and its
    `references/format.md`, plus one short block correcting what is different here
    (no disk, no delegation, two files, one door out). There is no third prompt.
  - **`SCREEN_STEPS = 10`.** An ask that needs more than that is an ask for a build.
  - **No new write path and no new paint path.** It writes `app.vendo` through the
    workspace and the render seam's `commit()` proxy paints it, exactly as the
    `claudeCode()` harness already builds apps.

  **Escalation** (`escalate`) writes `plan.vendo` and hands the ask on. The plan's
  skeleton paints in seconds and becomes the build's first frame — no consent step,
  one plain sentence, the work proceeds. `AppsRuntime.create` now accepts a
  caller-minted `appId` so the escalated plan and the build that finishes it land on
  one app and one view stream instead of two.

  **The routing is an adapter slot, and it is default-safe.** `AppsConfig.screen`
  takes core's new `ScreenAssembler`; composition is the only place that fills it
  (`apps.experimentalScreenAgent: true`, host config only). `vendo_make` falls
  through to `conductCreate` unchanged on every other answer — an escalation, an
  assembler that could not run, one that threw, and an `assembled` that left no app
  row behind. That last check is what makes the promise true rather than intended:
  the row is the truth, so a screen agent that saved bytes nobody can render costs a
  request nothing.

  Screens run unsandboxed, by design: a description is data, its props are
  schema-validated, and the kit treats them as inert.

  New in `@vendoai/core`: `ScreenAssembler`, `ScreenRequest`, `ScreenOutcome`.
  Edits go through the conductor as before — routing them needs the app's checkout
  projection, which is not this change.

- 98eba22: A streaming turn never goes silent, and a turn whose client vanished can be
  rejoined.

  **SSE keepalive.** A turn's first byte waits on a provider call and a slow tool
  streams nothing for its whole duration, so the wire could sit quiet long enough
  for a proxy or a browser to drop the connection. Every turn response now leads
  with an SSE comment frame and gets one per 15s of silence. `@vendoai/core` gains
  `withSseKeepalive`, `startSseKeepalive`, `SSE_KEEPALIVE_FRAME` and
  `DEFAULT_SSE_KEEPALIVE_INTERVAL_MS`; both engines' responses use it, and the
  `vendo try` dev server's own copy is gone.

  Hosts may notice: **the SSE body now contains comment frames.** They are ignored
  by the SSE grammar, so `useChat`, `DefaultChatTransport` and any spec-compliant
  parser see an unchanged message sequence — but a hand-rolled reader that assumes
  every frame starts with `data: ` needs to skip lines beginning with `:`. This is
  not a new event: there is no new `HarnessEvent` member and no new
  `data-vendo-*` part.

  **Stream resume.** The client half already shipped in `ai@6`
  (`ChatTransport.reconnectToStream`, which `useChat().resumeStream()` calls) and
  had no server to talk to, so a reload mid-turn painted the user's question and
  nothing else. The wire gains `GET /threads/:id/stream` — the SDK's own URL,
  method and 204 contract — serving the turn from the start of the stream and then
  following it live. Recording is per-turn, in memory, byte-capped, and dropped 30s
  after the turn settles; the persisted transcript remains the durable record.

  `useVendoThread` now resumes automatically after it loads a thread's transcript,
  and returns `resumeStream()` for surfaces that reconnect on their own.

- f7c6da2: A strict mount guards its creates, a refused turn writes nothing, and eleven
  exports nobody imported are gone.

  `expectedRevision` on a workspace commit entry gains its third state: a number
  compares, `null` means "this path must not exist yet", and the absent field
  stays unguarded. The SQL backend already refused a create built on a base that
  had moved; the hosted backend required a number and so degraded exactly that
  case into an unguarded write, silently overwriting the colleague who created
  the shared `/orgs` file first. Both backends and the memory reference are now
  held to the same conformance case.

  The per-turn refusal on a store that can serve neither the transcript nor the
  workspace is atomic: the doors are resolved before the first write, so a
  refused turn no longer leaves a `vendo_threads` row carrying the user's message
  on a deployment that can never answer it.

  `@vendoai/harnesses` drops eleven exports with no importer anywhere
  (`abandonPendingApprovals`, `guardApprovalIds`, `addAgentTool`,
  `buildAgentTools`, `guardedCall`, `previewApproval`, `computeInitialLoadout`,
  `createToolSearchSession`, `CAPABILITY_MISS_TOOL_NAME`,
  `createCapabilityMissDetector`, `scrubCapabilityMissText`). The `./vendo`
  subpath is untouched.

- 14e8246: A team-shared file now reaches the `claudeCode()` sandbox — and its edits come home.

  Orgs, teams and sharing shipped, and the sandbox harness never learned. On
  `claudeCode()` a file in an `/orgs/<org>` mount was invisible: "update our team's
  Quarterly Report app" answered that it does not exist, or built a personal
  duplicate. Worse, when a path did reach the box, the edit was filtered out on the
  way back — the agent said "done" and the write was dropped with no error
  anywhere. The same ask on `vendo()` worked, because the in-process façade asked
  `can()` and the sandbox path asked a hardcoded table of two mount prefixes.

  Permission on the sandbox path is now the workspace's, per file:

  - `WorkspaceFs.canCommit(path)` (new) answers "may this caller land a write
    here?" against LIVE rows — the same question `commit()` already asked itself
    per staged path. `/host` and anything outside the caller's mounts answer false;
    inside `/orgs/<org>/apps/<appId>/**` the app's own grants decide.
  - Checkout materializes every visible file and marks it read-only per FILE, so a
    viewer-level team app lands read-only beside an editable one and the model
    meets the refusal when it reaches for the file — not after rewriting it.
  - Sync-back re-asks the same question against live rows for writes and for
    deletions, so a grant revoked mid-session bites, and one refused org path can
    never take the caller's own work down with it.
  - A team app's `plan.vendo`/`app.vendo` are watched mid-turn like a personal
    app's, so its skeleton paints during the turn instead of at the end.

  `@vendoai/apps` is in this bump because the box door it publishes
  (`box/turn-routes.mjs`, the `./box-door` export, shipped in the machine image)
  carries the other half: its whole-tree and by-shape walks used to answer about
  `/user/` only, so a team file's edit was left on the box's disk. A new
  `@vendoai/harnesses` against an old `@vendoai/apps` is this bug again — the two
  must move together.

  For hosts this is additive: `WorkspaceFs` is produced by
  `workspaceStore(store).open(...)` and consumed, never implemented — the new
  method only widens what you can call on the workspace you already hold.

- fbf265b: A turn, a beat and a screen each say what they are — plus an app's code moves
  into its row.

  **`Turn.turnId`, and every audit row carries it.** There was no turn id anywhere,
  so an audit row, a mirrored tool call and a painted view could not be joined to
  the exchange they came out of. "Which calls belonged to the turn where the user
  asked for X" was unanswerable from the audit plane — the plane billing and
  reconciliation read. `mintTurnId()` mints `"trn_<32 hex>"`, the runtime stamps it
  where it already builds the `Turn`, and it rides the `RunContext` from that line
  on, so every guarded call, audit row and painted view downstream is joinable
  without a new parameter on fifteen signatures. Opaque to adapters. Additive for
  hosts: `RunContext.turnId` and `AuditEvent.turnId` are optional, and absent means
  "no turn", never "unknown turn".

  **Beats.** `HarnessEvent`'s `status` member gains an optional `phase`
  (`"understanding" | "planning" | "assembling" | "building" | "checking" |
"finishing"` — closed at six) and an optional `appId`. The union itself stays
  closed at four members, because adding one is a breaking change for every host
  renderer and widening one is not. A harness that yields only `label` puts the
  identical transient `data-vendo-status` chunk on the wire it always did.

  **`ScreenDescription`.** The view channel carried `UIPayload` —
  `{ formatVersion: string; [key: string]: unknown }` — an open bag whose seven real
  fields were read by inline cast at each consumer, so a deployed host frontend had
  nothing to hold us to. The fields are now declared and versioned, and the render
  seam GATES on them: what it compiles must parse or nothing paints, which is the
  law that seam already lived by for content that does not compile. The schema
  refuses `data` outright — a description says what to fetch, never what came back
  — so that law is enforceable rather than written down.

  **`AppDocument.source`.** An app's code had three homes: island TSX in
  `components`, the wire surface in workspace file rows, and — for a served app —
  only inside the sandbox snapshot behind `machine.snapshotRef`. Lose the snapshot
  and the customer's app was gone, because the store never had it. `source` maps
  POSIX-relative paths to `AppSourceFile { hash, bytes, text?, blobRef? }`, inline
  up to `WORKSPACE_INLINE_MAX_BYTES` (which moves to `@vendoai/core`, where its two
  readers can both see one answer) and blob-spilled past it through the SAME
  `FilesAdapter` the workspace rows already spill to. `machine.snapshotRef` becomes
  a cache: an app can always be rebuilt from its row.

  `checkoutApp` / `commitApp` in `@vendoai/apps` make a workspace a working copy of
  that row — checkout projects the document onto a filesystem, commit diffs the
  changed paths back. The two hot paths (`app.vendo`, `plan.vendo`) stay the render
  seam's, `trigger` travels untouched through every path, and a source key that
  would escape the app's directory is refused by the document validator.

  All additive for hosts: every new field is optional, every schema stays
  `.passthrough()`, and rows written before this keep parsing unchanged.

- a0dbfc6: The agent can now be told who the user is and what they are looking at.

  Two seams, both optional, both merged into one `[Situation]` block on every
  message the user sends:

  - **User facts.** The `user` resolver on the `authJs()` and `jwt()` auth presets
    may now return a `facts` object alongside the principal, and those facts reach
    the prompt. The session is decoded once per request for both the principal and
    the facts. An anonymous request resolves no facts.
  - **Live screen context.** `useVendoContext(data)` publishes structured host data
    for as long as the component is mounted, and retires it on unmount. Several
    mounted callers coexist and merge. `VendoProvider` also takes `captureScreen`
    (default `true`) to control the screen snapshot that rides the same channel.

  **BREAKING (`@vendoai/ui`, `@vendoai/vendo/react`): `useVendoContext` is now
  `useVendoProvider`.** The name `useVendoContext` previously belonged to the
  zero-argument hook that read everything `VendoProvider` supplies; it now belongs
  to the host-facing hook above, which takes data and returns nothing. Both names
  still exist, so the compiler is the thing that catches this:

  ```diff
  - const { client } = useVendoContext();
  + const { client } = useVendoProvider();
  ```

  Because both names still exist, the compiler catches this rather than the
  runtime: an existing zero-argument call now fails with `TS2554: Expected 1
arguments, but got 0`. Rename the call and you are done — nothing else about the
  provider value changed.

- 39a7ecc: **Both writers get a design brief.** The screen agent and the `claudeCode()`
  builder could name every component in the catalog and had nothing to say about
  WHICH one, HOW MANY, or WHERE — so a screen was whatever the model reached for
  first.

  **The design law ships inside the skill.** `buildingAppsSkill` gains a
  `## What a good screen looks like` section, written in `.vendo` terms rather than
  CSS, because every one of these is a choice made in the plan: lead with the
  answer, fewer parts and better ones, never say the same thing twice, bind the
  rows as they come, group by what the person came to do, `col` is width and never
  slicing, pick the chart by the shape of the data, a hole is a `<Cannot>`, the
  words are the host's own, and an `<Island>` styles with the theme's CSS variables
  and nothing else. One text, in the skill BOTH writers read, so `claudeCode()` and
  the screen agent cannot be taught different design.

  **The host's theme and design rules now reach both writers.** `apps.designRules`
  and the theme tokens are documented seams a host sets and expects to be obeyed.
  They reached the fill worker of the retired conductor and nothing else — so on
  both live write paths those two config keys silently did nothing. The new
  `hostDesignBrief` (exported from `@vendoai/apps`) renders that pair ONCE, and
  composition hands the same string to both seams: the screen agent's brief,
  through a `design` slot beside `system` on `ScreenInput` and
  `ScreenAssemblerDeps`, and the composed prompt `claudeCode()` thinks with. The
  slot is a thunk, not a value, so a rules change applies to the next screen rather
  than the next boot.

  Deliberately NOT inside `claudeCode()`: that harness thinks with `turn.system`
  whole and alone and appends nothing after the host's prompt seam, so the prompt
  seam is the only honest place for them.

### Patch Changes

- 3f98372: **Apps remember what they were asked for.** A screen or build run is stateless,
  so the ARTIFACT now carries its own context: `AppDocument` gains an additive
  `memory` of two parts.

  - **`asks`** — every `vendo_make` request that touched this app, VERBATIM and in
    order, the create ask first. Never a paraphrase (a paraphrase drifts the intent
    it exists to preserve) and never the `<context>`-fenced composite an engine is
    briefed with: the memory holds what the PERSON said, so one calling agent's
    background for one call cannot become a standing requirement.
  - **`decisions`** — a short block the agent writes through `save_app`'s new
    optional `decisions` field: choices made, constraints found, things ruled out.
    REPLACED on every run that writes one, never appended, because a superseded
    decision presented as a current one is worse than no memory at all.

  Both are read back where the next editor actually reads: the edit brain's brief
  OPENS with the memory, ahead of the document, and the in-box builder's task
  context does the same. Without it an editor meets a deliberately filtered list
  and "fixes" it.

  Server-written throughout. `AppsRuntime.remember` is the one door that writes
  memory (`editor`-gated); a model-authored `memory` is stripped from a generated
  document, and an edit pins the stored one. Caps live at that write site rather
  than in the schema — the last 20 asks, 1KB of decisions — so a stored row
  survives a cap that changes. Reasoning traces, transcripts and tool outputs are
  deliberately not stored.

- 2819bcc: A screen-agent save that never reached the screen now hears the floor, instead of
  "app not found".

  The paint seam refuses to paint a document that does not compile, does not render,
  or does not pass the checks floor — and that refusal is also the reason the app has
  no store row, because `AppsRuntime.authored` runs only on a paint. `save_app`
  answered every landed commit with "Run validate on it now.", and `validate({appId})`
  is row-scoped, so the assembly loop's one floor door replied `not-found` on exactly
  the document that needed judging. Live 2026-08-06 ("a dashboard for my upcoming
  bills and subscriptions") that is all the operator saw — `render seam: source did
not reach the store` and `validate failed: app not found` — while the loop, told
  nothing, saved again and shipped a screen no door had judged.

  The seam now records which apps a commit put on screen (`paintedIn`, beside the
  commit rather than on `CommitResult`, which stays the store's own answer), and
  `save_app` reads it: a save that did NOT paint runs the same gate the builder runs
  before it reports done (`validateWrittenApps` → `validate({ document })`, no row
  required) and hands the findings straight back. A save that DID paint is unchanged
  and costs nothing extra — the seam already ran those checks before it emitted.

- 6a3d9e3: refactor(apps)!: the brain dies — one router, one builder, zero middlemen

  `AppsRuntime.create` and `AppsRuntime.edit` no longer run a generation pipeline.
  They run the SAME engine `vendo_make` runs: the screen assembler in the
  `apps.screen` slot. "The seam routes, not the caller" was never a `vendo_make`
  property — it is the runtime's, and now every caller behind it (the HTTP wire,
  the React client, a seed script) gets it.

  - **`create`** asks the assembler first. `assembled` → the row it stored is the
    answer. `escalate` → the plan it wrote is the build's whole brief.
    `unavailable`, a throw, or an unfilled slot → an honest failure that says so.
  - **`edit`** is the assembler opening the app's own `app.vendo`, rewriting it and
    saving it; the save lands through `AppsRuntime.authored`, so the store write,
    the checks floor and the paint are the shipped ones. An `escalate` on an
    existing app is the escalation ladder — an automation, or a box.
  - **The machine lane briefs itself from the plan.** `<Server kind="steps" |
"agentic" | "box" [served]>` is the escalating agent's own declaration and
    nothing re-derives it; a plan that escalated with no `<Server>` defaults to
    `kind="box"`, because the escalation is itself the claim that assembly cannot
    serve the ask. The in-box task carries the plan text verbatim, the person's ask
    verbatim, and the app's memory.

  ## Breaking

  - **`apps.fill` (`{ model }`) is gone**, and so is the fast fill tier it named:
    the group fill workers it pointed at do not exist any more. `createVendo`'s
    `models.fill` seat (and its deprecated `paint.model` predecessor) are still
    accepted and validated, and are now **ignored** — nothing reads them — so a host
    config does not have to change in the same release. **Migration:** delete
    `apps: { fill: … }` from a direct `createApps(...)` composition, and drop
    `models.fill` / `paint` from `createVendo(...)` at your convenience. Nothing
    replaces them: there is one generation seat (`apps.model` / `models.default`),
    plus whatever the assembler's own harness uses.
  - **`apps.screen` is required for `create` and `edit`, not only for `vendo_make`.**
    A deployment that composes `@vendoai/apps` without a `ScreenAssembler` now fails
    those doors loudly instead of quietly serving them from a second engine.
    `createVendo` fills the slot for you.
  - `UNSTORED_APP_ID` is no longer exported from `@vendoai/apps`.
  - An app row's `session` (the brain's transcript) is no longer written or read.
    Existing rows are unaffected until their next write, which drops it. An app's
    memory (`remember`) is what carries intent forward.

  ## Deleted

  `generation/conductor.ts`, `generation/brain.ts`, `generation/fill.ts`,
  `generation/prompts/`, `generation/contracts/sections.ts`, the island lane and
  `laneGates` in `generation/lanes.ts`, `growSkeleton` / `spliceFragment` /
  `Skeleton.slots`, `FIX_ROUNDS`, the commit-gate lead paragraphs, and the session
  plumbing. `skeletonFromPlan` stays — it is the live plan-paint path at the render
  seam.

- Updated dependencies [2e792a1]
- Updated dependencies [963d980]
- Updated dependencies [b022eb3]
- Updated dependencies [1572060]
- Updated dependencies [a004031]
- Updated dependencies [21c8b10]
- Updated dependencies [3f98372]
- Updated dependencies [21c8b10]
- Updated dependencies [1bb535b]
- Updated dependencies [05ac24c]
- Updated dependencies [8d623ec]
- Updated dependencies [a004031]
- Updated dependencies [10a2b44]
- Updated dependencies [2722d81]
- Updated dependencies [f884bfe]
- Updated dependencies [d6f5e28]
- Updated dependencies [56e0cc3]
- Updated dependencies [a004031]
- Updated dependencies [a5293af]
- Updated dependencies [b022eb3]
- Updated dependencies [c9df3f7]
- Updated dependencies [6eb8a04]
- Updated dependencies [215bfcc]
- Updated dependencies [fbf265b]
- Updated dependencies [ce98c54]
- Updated dependencies [2ed91b0]
- Updated dependencies [e6aaa7a]
- Updated dependencies [ab5d181]
- Updated dependencies [d0c3cc9]
- Updated dependencies [0197470]
- Updated dependencies [798b618]
- Updated dependencies [8132329]
- Updated dependencies [10a2b44]
- Updated dependencies [d1ff923]
- Updated dependencies [98eba22]
- Updated dependencies [f7c6da2]
- Updated dependencies [14e8246]
- Updated dependencies [6a3d9e3]
- Updated dependencies [fbf265b]
- Updated dependencies [38a840d]
- Updated dependencies [a0dbfc6]
- Updated dependencies [39a7ecc]
  - @vendoai/core@0.8.0
  - @vendoai/apps@0.8.0
  - @vendoai/guard@0.8.0
