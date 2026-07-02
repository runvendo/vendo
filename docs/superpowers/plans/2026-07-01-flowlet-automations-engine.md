# Flowlet Automations Engine (ENG-188 Phase 2) Implementation Plan

> **For agentic workers:** execute task-by-task with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking. Per Yousef's global rules this plan is high-level: goals, files, steps, and decisions — no code. The spec with full worked examples is [`docs/superpowers/specs/2026-07-01-flowlet-automations-proposal.md`](../specs/2026-07-01-flowlet-automations-proposal.md); all 13 open questions were resolved per its recommendations (brainstorm 2026-07-01).

**Goal:** Build the approved automations slice: DSL schema + interpreter + store + in-process scheduler as pure library code in `@flowlet/agent`, wire it into demo-bank so the Slack snitch becomes pure data (demo parity is the acceptance bar), and add chat authoring via an approval-gated `create_automation` tool with an automation card built from existing approval-card patterns (card pauses for Yousef before PR).

**Architecture:** New `src/automations/` module in `packages/flowlet-agent` (moves wholesale to `@flowlet/runtime` at the carve-out). Everything from `fire()` onward is deployment-agnostic and uses only seams (store, toolset, policy); embedded producers are an in-process cron tick and `emitHostEvent`. Demo-bank's poller survives as an event adapter; `rules-store.ts` and `set_rule` are deleted.

**Tech stack:** TypeScript, zod (schema), `jsonata` (expression language), `croner` (cron next-occurrence), vitest, existing `buildToolset`/`wrapTool`/`ApprovalPolicy` machinery, ai SDK for agent steps.

**Verification commands:** `pnpm test`, `pnpm typecheck`, `pnpm lint` at repo root (turbo). Demo parity via `pnpm demo` in a real browser with screenshots.

---

## Ground rules for every task

- TDD: write the failing test first, watch it fail, implement, watch it pass, commit. One commit per green step.
- No product/scope decisions beyond the approved spec; if a conflict with the locked architecture emerges, stop and surface it.
- The interpreter and runner never import Next.js, the demo app, a database, or timers directly (timers live only in the scheduler; tests inject fake clocks).
- Two independent Codex reviews of the spec were triaged with Yousef (2026-07-01): ALL fixes accepted, plus two rulings — `run_automation_now` is dry-run by default (`live: true` opt-in), and v1 retains ALL runs (no pruning; retention is a marked TODO). The spec doc's "Amendments" section is the changelog; the tasks below already incorporate it.

---

## Task 1: Dependencies and module scaffold

**Files:**
- Modify: `packages/flowlet-agent/package.json` (add `jsonata`, `croner`)
- Create: `packages/flowlet-agent/src/automations/` (empty module dir, `index.ts` barrel)
- Modify: `packages/flowlet-agent/src/index.ts` (re-export the barrel as it fills in)

**Steps:**
- [ ] Add `jsonata` and `croner` as dependencies of `@flowlet/agent`; `pnpm install`.
- [ ] Confirm `pnpm typecheck` and `pnpm test` still pass from root.
- [ ] Commit.

## Task 2: DSL types + zod schema

**Files:**
- Create: `packages/flowlet-agent/src/automations/schema.ts`
- Test: `packages/flowlet-agent/src/automations/schema.test.ts`

**What it is:** The zod schema and inferred TS types for the whole spec document exactly as in the proposal section (a): `dslVersion: 1`, name/description/prompt, the three trigger variants (schedule with cron+IANA timezone or one-shot `at`; host_event; composio), optional top-level `if` guard, `execution` discriminated on `mode` (`steps` = node list; `agent` = goal/tools/maxToolCalls), the four node types (tool, agent, branch, for_each) with per-step `if` and `onError`, `approvals.preAuthorized`, `limits`.

**Validation rules enforced by the schema (test each):**
- [ ] Step ids required, unique across the whole tree (including nested), snake_case (identifier-safe for JSONata dotted refs); `for_each.as` may not shadow `trigger`/`steps`/`run`/`user`/`item`/`index`.
- [ ] Hard caps: ≤ 25 steps total (counting nested), `for_each.maxItems` ≤ 100 (default 100), `maxFiringsPerHour` ≤ 60 (default 60), agent `maxToolCalls` bounded.
- [ ] `mode: "agent"` requires non-empty goal and a tools allowlist (may be empty array only for pure-judgment agent *steps*, not top-level agentic mode — top-level with no tools is meaningless; reject).
- [ ] Schedule triggers require a valid IANA timezone with `cron`, and reject specs with both `cron` and `at`.
- [ ] The four worked examples from the spec doc parse successfully (fixtures copied verbatim into the test) — this keeps the doc honest.
- [ ] Commit.

## Task 3: Expression evaluation (JSONata wrapper)

**Files:**
- Create: `packages/flowlet-agent/src/automations/expressions.ts`
- Test: `packages/flowlet-agent/src/automations/expressions.test.ts`

**What it is:** The only place JSONata is touched. Three entry points: evaluate a bare guard expression to boolean; resolve a step `input` object (walk values; `{{ }}` interpolation inside strings; a value that is exactly one `{{ expr }}` resolves to the raw JSON value); build the closed scope (`trigger`, `steps`, `run`, `user` — nothing else).

**Behaviors to test:**
- [ ] Interpolation stringifies; whole-value expressions return raw arrays/numbers/objects.
- [ ] Guard truthiness: non-boolean guard results are an error (fail closed), not coerced.
- [ ] Unknown names resolve to undefined (JSONata semantics) and a guard referencing nothing is false, not a crash.
- [ ] JSONata syntax errors surface as typed errors naming the offending expression (the compiler feedback loop depends on this).
- [ ] Safe profile via AST validation at creation time: reject `$eval` and inline function/lambda definitions; cap expression length (1,000 chars).
- [ ] Evaluation timeout and output-size cap so a pathological expression or huge transform fails the step rather than hanging the firing.
- [ ] Commit.

## Task 4: AutomationStore seam + in-memory implementation

**Files:**
- Create: `packages/flowlet-agent/src/automations/store.ts` (interfaces + `InMemoryAutomationStore`)
- Test: `packages/flowlet-agent/src/automations/store.test.ts`

**What it is:** The Store-seam contract from spec section (b), library-shaped (no SQL here; Postgres lands in ENG-198 behind the same interface): automation pointer records (status enum incl. `disabled_error`, denormalized trigger kind/key, counters incl. `consecutive_failures`), immutable versions (spec + scope-hashed `grants` + nullable `manifest_hash` + provenance), runs (deterministic firing id from `(automationId, source, eventId)` with uniqueness, status enum incl. `skipped` and `waiting_approval`, trigger envelope, inline step results with size caps, `pending_approval`, `is_test`, pinned version + manifest hash).

**Behaviors to test:**
- [ ] Creating an automation writes version 1 and points at it; every update appends an immutable version (with fresh grants) and moves the pointer; old versions remain readable.
- [ ] Runs pin the version they executed; querying runs after an edit still yields the old spec.
- [ ] Deterministic firing id: inserting a run for an already-seen `(automationId, source, eventId)` is rejected as a duplicate (dedup contract).
- [ ] Counters (total runs/failures, consecutive failures, last run/status) update on run finalization; a success resets the consecutive-failure streak.
- [ ] Retain everything: no eviction at any run count (per ruling); `skipped` runs stored compactly (no steps array); oversized step outputs truncated with flag + recorded full size.
- [ ] Lookup by trigger kind+key+subject returns only `enabled` automations owned by that subject (the ingest fan-out query never crosses users).
- [ ] Commit.

## Task 5: Interpreter (step-graph runner)

**Files:**
- Create: `packages/flowlet-agent/src/automations/interpreter.ts`
- Test: `packages/flowlet-agent/src/automations/interpreter.test.ts`

**What it is:** Pure function from (validated spec version, trigger payload, principal, policy-wrapped toolset + descriptors, agent-step runner, pre-authorized list) to a run result with per-step records. No I/O, no timers, no store access (the runner in Task 6 persists).

**Key design points (from the spec as amended):**
- Dangerous-step handling does NOT reuse the ai SDK's turn-based `needsApproval` loop: the interpreter consults the policy decision per step itself. `allow` → execute; `approve` + a matching scope-hashed grant on the version → execute; `approve` without a valid grant (missing, or hash drift) → suspend with a durable checkpoint (step index + accumulated step outputs) and result status `waiting_approval`; `deny` → step fails.
- A suspended run resumes via an explicit `resume(checkpoint, decision)` entry point (approve → continue from exactly the paused step, replaying nothing; decline → run fails at that step).
- Agent steps go through an injected `AgentStepRunner` interface; tests use a stub. The real implementation is Task 7.
- Dry-run mode (for `run_automation_now` default): read-only tools execute; mutating tools are simulated — evaluated input validated and recorded, no execution.

**Behaviors to test (stub tools + stub agent runner):**
- [ ] Sequential tool steps; `steps.<id>.output` visible to later expressions; branch children addressable, `for_each` children only via `steps.<loop_id>.output.iterations[]`.
- [ ] Per-step `if` skips just that step; `branch` takes then/else; `for_each` binds `item`/`index`, respects `maxItems`, and truncation is recorded on the step result (no silent cap).
- [ ] Evaluated step input is validated against the tool's input schema before execute; a mapping that produces a bad shape fails the step with a useful error.
- [ ] `onError`: fail stops the run as `failed`; continue records the error and proceeds; retry re-invokes N times then applies fail — and retry is rejected/downgraded on tools without `idempotentHint`/`readOnlyHint`. Idempotency keys (`<run>/<step>/<attempt>`) recorded on every step attempt.
- [ ] Pause/resume round-trip: no grant → `waiting_approval` with checkpoint; valid grant → unattended; grant with stale scope hash → pauses anyway; deny fails the step; resume does not re-execute completed steps.
- [ ] Dry-run: mutating steps simulated + recorded, read-only steps real.
- [ ] Agent step: input resolved via expressions, allowlist passed through, output validated against the declared JSON schema (invalid output = step failure).
- [ ] Run wall-clock/step-count guards enforced.
- [ ] Commit (this task will be several test→implement→commit cycles, one per behavior cluster).

## Task 6: Runner (`fire`) + InProcessScheduler

**Files:**
- Create: `packages/flowlet-agent/src/automations/runner.ts`
- Create: `packages/flowlet-agent/src/automations/in-process-scheduler.ts`
- Test: `packages/flowlet-agent/src/automations/runner.test.ts`, `in-process-scheduler.test.ts`

**What it is:**
- `runner.fire(automationId, envelope)`: envelope is `{ source, eventId, subject, occurredAt, payload }` → load current version (store) → dedup on the deterministic firing id (duplicate ⇒ no-op) → enforce 60/hr firing cap → create run row → evaluate top-level guard (`false` ⇒ finalize as compact `skipped`) → interpret → finalize run + counters → `disabled_error` after 5 consecutive failures (`skipped` never counts as failure). Firings are serialized per automation (in-process queue); a firing arriving mid-run queues.
- `InProcessScheduler`: the embedded Scheduler-seam implementation. One injectable clock tick (default 60s) computes due schedule triggers with croner against each automation's IANA timezone (cron tick timestamp = the `eventId`; missed fires are skipped, next occurrence wins); `emitHostEvent(type, envelope)` fans out to enabled automations matching `host_event`+type owned by the envelope's subject, and calls `fire`. Composio triggers: explicitly unsupported here (cloud-only), registering one is a no-op with a warning.

**Behaviors to test (fake clock, in-memory store, stub interpreter):**
- [ ] Cron due-time firing across a timezone; one-shot `at` fires once then never again.
- [ ] Host event fan-out hits only enabled automations with matching event key AND subject (Alice's transaction never fires Bob's automation).
- [ ] Duplicate envelope (same source+eventId) does not fire twice.
- [ ] Firing cap: 61st firing in an hour is dropped and recorded (not silent).
- [ ] 5 consecutive failures flip status to `disabled_error`; a success resets the streak.
- [ ] Serialization: overlapping firings of one automation run one-at-a-time; different automations run independently.
- [ ] `waiting_approval` runs persist their checkpoint and resume through the runner; pausing/editing/deleting the automation cancels its pending runs.
- [ ] Commit per behavior cluster.

## Task 7: Authoring tools + real agent-step runner

**Files:**
- Create: `packages/flowlet-agent/src/automations/tools.ts` (the tool factory)
- Create: `packages/flowlet-agent/src/automations/agent-step.ts` (real `AgentStepRunner` on the ai SDK)
- Create: `packages/flowlet-agent/src/automations/instructions.ts` (compiler guidance snippet for host system prompts)
- Test: `packages/flowlet-agent/src/automations/tools.test.ts`, `agent-step.test.ts`
- Modify: `packages/flowlet-agent/src/index.ts` (public exports)

**What it is:**
- `createAutomationTools({ store, scheduler, runner })` returning engine-source tools: `create_automation` (input schema IS the DSL zod schema), `update_automation`, `list_automations`, `get_automation_runs`, `pause_automation`, `resume_automation`, `delete_automation`, `run_automation_now` (dry-run by default: mutating steps simulated, evaluated inputs recorded; `live: true` explicit opt-in through the full policy/grant path; run flagged `is_test`).
- `create_automation`/`update_automation`/`delete_automation` carry `destructiveHint` descriptor annotations so the existing annotation policy layer yields `approve` — creation of standing authority is always approval-gated, with no new policy machinery.
- Grant capture: the create/update tool input carries the granted-tool list the card collected (grants are NOT part of the compiler-emitted spec); the tool computes each grant's scope hash (tool descriptor + trigger + guard + input mapping) and stores grants on the new version. Grants never carry across versions.
- Compiler guidance (exported string, appended to host instructions): prefer deterministic; agent steps only for judgment over unstructured input; fully agentic only when steps are unknowable; only reference registered tools/events; JSONata usage rules.
- Real `AgentStepRunner`: bounded ai SDK loop (allowlisted tools, `maxToolCalls` stop condition, final structured output validated against the step's declared schema). Tests with the ai SDK mock model, as `engine.test.ts` already does.

**Behaviors to test:**
- [ ] `create_automation` rejects an invalid spec with actionable zod errors (the model's correction loop) and persists + schedules a valid one, with scope-hashed grants on the version.
- [ ] Update writes a new version with FRESH grants and re-registers the trigger; pause/resume/delete affect scheduler registration and cancel pending `waiting_approval` runs.
- [ ] `run_automation_now` defaults to dry-run (mutating step simulated, recorded, not executed); `live: true` executes through policy/grants; both flag `is_test`.
- [ ] Agent-step runner respects the allowlist (a non-allowlisted tool is not even offered) and validates output shape.
- [ ] Commit per behavior cluster.

## Task 8: Demo-bank integration — snitch becomes data (demo parity)

**Files:**
- Create: `apps/demo-bank/src/flowlet/automations.ts` (singleton: in-memory store + scheduler + runner wired with demoPolicy, host tools, and Composio execution for the firing path)
- Modify: `apps/demo-bank/src/flowlet/poller.ts` (poller becomes the event adapter: keep polling + diffing Maple's API, but emit `transaction.created` via `emitHostEvent` instead of matching rules; snitch text/matching logic deleted)
- Modify: `apps/demo-bank/src/app/api/flowlet/poll/route.ts` (returns the runner's fire events so `FlowletToast` keeps working; keep response shape compatible or update the toast accordingly)
- Modify: `apps/demo-bank/src/flowlet/tools.ts` (delete `set_rule`; add the automation tool factory output to `demoTools()`)
- Modify: `apps/demo-bank/src/flowlet/agent.ts` (replace the "standing natural-language rules" instruction block with the compiler guidance from Task 7; declare the `transaction.created` host event and its payload fields in the instructions so the compiler knows the closed world)
- Delete: `apps/demo-bank/src/flowlet/rules-store.ts`, `rules-store.test.ts`
- Modify: `apps/demo-bank/src/app/api/flowlet/reset/route.ts` (reset clears the automation store instead of the rules store)
- Test: update `poller.test.ts`; add `automations.test.ts` covering the end-to-end embedded firing (fake transaction event → automation fires → Slack poster stub called with interpolated text)

**Decisions locked for this task:**
- The firing-path toolset is built once per firing from the same sources as chat (host tools + connected Composio toolkits for the principal) through `buildToolset` with `demoPolicy` — the automation can only do what chat can do.
- The poller adapter emits full trigger envelopes: `eventId` = the Maple transaction id (so poller restarts and repeated diffs can never double-fire), `subject` = the demo user, payload per the spec's declared `transaction.created` contract: id, merchant, descriptor, category, hour, time, amountDollars, direction, cardId? (mapping mostly exists in `poller.ts`'s `toTxLike`; add `time` label and optional `cardId`).
- Demo parity bar: via chat, "snitch on me in #general if I order food delivery late at night" compiles to the spec-doc example-1 automation; approving it registers it; a new late-night transaction fires a real Slack post (Composio verified working per ENG-178) and the toast shows.

**Steps:**
- [ ] Tests first for the adapter + end-to-end firing with a Slack poster stub; then wire for real.
- [ ] Manual demo parity check with `pnpm demo` in a real browser (create rule in chat, plant a late-night order, watch Slack + toast). Screenshots saved for the PR.
- [ ] Update the Orca worktree comment (library + demo wiring done, card next).
- [ ] Commit.

## Task 9: Automation card (Yousef-gated) — build, screenshot, PAUSE

**Files:**
- Create: `packages/flowlet-shell/src/components/AutomationCard.tsx`
- Test: `packages/flowlet-shell/src/components/automation-card.test.tsx`
- Modify: `packages/flowlet-shell/src/components/MessageList.tsx` (route `create_automation`/`update_automation` approval requests and tool outputs to the card instead of the generic `ApprovalCard` JSON dump)
- Modify: `packages/flowlet-shell/src/components/tool-labels.ts` (labels for the automation tools)
- Possibly modify: `packages/flowlet-shell/src/styles.css` (only if an existing class is missing; reuse `fl-approval`, `fl-btn` patterns — minimal new styling per the brainstorm)

**Content (from spec section (d) outline as amended):** name, tier badge, status; compiler restatement + original prompt; human-readable trigger line including the guard; per-step lines showing the tool, its input mappings and concrete targets (channel, recipient, payee), dangerous flags, agent-step goals + allowlists; permissions block with per-gated-tool grant toggles and what each grant's scope covers (proposal state); approve/decline (proposal state) or pause/resume/run-now summary (post-creation output state); raw-spec disclosure.

**Steps:**
- [ ] Component tests for both states (proposal/approval and created/output) plus the pre-authorization toggle wiring into the approval response.
- [ ] Render in the real demo in a browser; capture screenshots of both states (light/dark if the shell theme supports it).
- [ ] **PAUSE. Post screenshots for Yousef and stop all card work until he rules.** No PR yet. Update the worktree comment (card screenshots awaiting Yousef).

## Task 10: Final verification + one PR

**Steps (only after Yousef approves the card):**
- [ ] Apply any card feedback.
- [ ] Full `pnpm test`, `pnpm typecheck`, `pnpm lint` green at root; re-run the browser demo-parity flow; capture final screenshots.
- [ ] Sync docs: mark the proposal doc's open questions as resolved with the brainstorm outcome; ensure this plan's checkboxes reflect reality.
- [ ] One PR (never merge): summary, spec/plan links, screenshots, verification evidence. Update the worktree comment (PR open, awaiting review). Stop.

---

## Self-review notes

- Spec coverage: DSL (Tasks 2–3), storage incl. grants/dedup/retain-everything (4), interpreter incl. hybrid/agent steps + grant-checked approvals + dry-run (5, 7), firing path + envelope + caps + serialization (6), demo parity replacing rules-store/poller (8), authoring + compiler guidance (7, 8), card with pause (9), timezone (6), dslVersion (2; lazy migration has nothing to migrate at v1 — no task needed, noted deliberately).
- Deliberately out: Postgres schema, pg-boss, webhook ingest, token exchange (ENG-198/202); Composio trigger registration (cloud-only, no-op here); management UI beyond the card.
- Risk watched: the ai SDK's turn-based approval loop doesn't fit unattended runs — addressed structurally in Task 5 (interpreter-level pause/resume, no `needsApproval` reuse in the firing path).
