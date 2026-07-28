# Generation Pipeline Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task below is executed by ONE sub-orchestrator subagent that MUST read the referenced live code before expanding its steps; interfaces defined here are LOCKED and may not be redesigned by builders.

**Goal:** Replace the generation engine's front half with the brain/workers/reviewer architecture per `docs/superpowers/specs/2026-07-28-generation-pipeline-v2-design.md`, in place, deleting what each piece replaces.

**Architecture:** One big-model "brain" session per app (plans, directly builds tiny asks, edits like a file), fast no-think workers filling plan groups in parallel into a deterministic skeleton, a plug-in checking layer (fact checks + AI reviewer + host checks), sandbox work bound after build. Built on one integration branch; final merge to main is the cutover, gated on one complicated end-to-end prompt in a demo host (full bench deferred by Yousef).

**Tech Stack:** Existing monorepo (pnpm + turbo), TypeScript, `ai` SDK with `@ai-sdk/anthropic`, existing wire compiler in `packages/core`, vitest.

**Branch strategy:** Integration branch `generation-rebuild` off `main`. Piece PRs target `generation-rebuild`, auto-merge when green. The final `generation-rebuild` → `main` PR is the cutover. No `V2`/`New` suffixes anywhere — pieces replace and delete in place on the branch.

**Non-goals (do not build):** the D1 composites themselves · catalog search · prompt polish (plain v1 prompts, Yousef iterates later) · layer-3 changes · pins/drift changes · plan caching · speculative fill during plan streaming · multi-lens review · full bench integration (deferred).

---

## Locked interfaces (design decisions builders may NOT change)

### Plan structure (`packages/core`)

```ts
// packages/core/src/genui/plan/types.ts
export interface AppPlan {
  name: string;
  queries: PlanQuery[];               // declared once, referenced by leaves
  surface: PlanContainer | PlanGroup[]; // containers OR a flat list of groups
  island?: { name: string; purpose: string; tools: string[] };
  server?: { kind: "steps" | "agentic" | "box"; schedule?: string; why: string;
             dependsOn: string[] };   // group ids that wait for the box
  cannot: string[];                   // honest refusals, verbatim user-facing
}
export interface PlanQuery { id: string; tool: string; input: Record<string, unknown> }
export interface PlanContainer { kind: "tabs" | "pages"; items: Array<{ title: string; groups: PlanGroup[] }> }
export interface PlanGroup { id: string; title?: string; layout?: "stack" | "grid";
                             leaves: PlanLeaf[] }                    // ≤5 leaves enforced by parser
export interface PlanLeaf { component: string; query?: string;      // query id reference
                            purpose: string; attrs?: Record<string, string> } // col/row/span
```

The plan is emitted as wire-text (`<Plan>…</Plan>`, grammar mirroring the types 1:1) and parsed by `compilePlan(text): { plan?: AppPlan; issues: string[] }`. Fact checks run inside `compilePlan` given a `PlanFacts` argument (`{ tools: string[]; components: string[] }`): unknown tool/component/unparseable schedule → issue, never a throw.

### Text editing (`packages/core`)

```ts
// packages/core/src/genui/wire/text-edit.ts
export interface TextEdit { old: string; new: string }
export interface TextEditResult { text?: string; issue?: string } // "no match" | "2 matches" with excerpt
export const applyTextEdits = (source: string, edits: TextEdit[]): TextEditResult
// packages/core/src/genui/wire/print.ts gains { ids: false } — id-free printing (model-facing)
// identity carry: recompile maps old→new node ids by position OUTSIDE replaced spans;
// nodes intersecting a replaced span get fresh ids. Exposed as:
export const recompileWithIdentity = (edited: string, previous: Tree): CompileResult
```

### Checking layer (`packages/apps`)

```ts
// packages/apps/src/checking/types.ts
export interface Finding { severity: "block" | "warn"; where: string; message: string } // message = teaching sentence
export interface Check { name: string;
  run(input: { app: GeneratedAppDocument; request: string; plan?: AppPlan }): Promise<Finding[]> }
export interface CheckingLayer { checks: Check[]; run(input): Promise<Finding[]> } // parallel, flat-merged
```

Fact checks (parse/exists/schema-fit) are built-in `Check`s. The reviewer is a `Check` that makes one model call. Hosts add `Check`s via `AppsConfig.checks?: Check[]` (appended, never replacing built-ins).

### Brain session (`packages/apps`)

```ts
// packages/apps/src/generation/brain.ts
export interface BrainTurn { role: "user" | "brain"; text: string; at: string }
// persisted on the app record as `session: BrainTurn[]` (server-authoritative, capped at 20 turns,
// older turns dropped oldest-first; current app text is always re-printed fresh per call)
export interface BrainOutcome =
  | { kind: "direct"; wire: string }          // tiny ask: finished app markup
  | { kind: "plan"; plan: AppPlan }
  | { kind: "edits"; edits: TextEdit[] }
  | { kind: "amend"; plan: AppPlan }          // structural edit: new/changed parts only
  | { kind: "cannot"; reasons: string[] }
```

The brain model = `config.model`, thinking enabled (adaptive). Workers model = `config.paint?.model ?? config.model`, thinking off (reuse the existing no-think switch; the `paint` config key is renamed `fill` in the cutover task).

### Skeleton + fill (`packages/apps`)

Skeleton: `skeletonFromPlan(plan): { tree: Tree; slots: Record<groupId, nodeId> }` — deterministic, containers rendered as chrome, every leaf a placeholder node (`source: "prewired"`, `pending: true` prop). Fill workers emit fragments; `spliceFragment(tree, slots[groupId], fragment): Tree`. Concurrency: `pLimit(config.fillConcurrency ?? 2)`. Queries execute at plan time via the existing tool registry (read-risk only); results attached to worker prompts as samples and kept for first open.

### Expressions (`packages/core` + renderer)

Binding value form `{ $expr: "sum(invoices.amount_cents) / count(clients)" }`. Grammar: identifiers/field paths, numbers, `+ - * / ()`, calls `sum count average min max difference days_until group_by`. `evaluateExpr(expr, data): unknown` in `packages/core`, executed at bind-resolution in the renderer (same place `$path` resolves). Parse/fields-exist = fact check; sense = reviewer.

---

## Wave 0 — foundations (3 tasks, parallel, no shared decisions)

### Task 1: Plan dialect + compiler + fact checks

**Files:**
- Create: `packages/core/src/genui/plan/types.ts`, `packages/core/src/genui/plan/compile.ts`, `packages/core/src/genui/plan/compile.test.ts`
- Modify: `packages/core/src/index.ts` (export)

- [ ] Read `packages/core/src/genui/wire/` first (parser conventions, issue formatting).
- [ ] Failing tests: full spec example (`Tabs > Tab > Group > Leaf`, plan-level `<Query>`, `<Server>`, `<Island>`, `cannot`) parses to the locked types; a bare `<Group>` list (no container) parses; group with 6 leaves → issue; container inside a group → issue (unwritable depth); unknown tool → issue naming the tool and listing real ones; unknown component → issue; bad cron schedule → issue; leaf referencing an undeclared query → issue.
- [ ] Implement `compilePlan` (reuse the wire tokenizer; forgiving about whitespace/fences like `extractWire`).
- [ ] Tests green; commit `feat(core): plan dialect compiler with fact checks`.

### Task 2: Text-edit machinery + id-free printing + identity carry

**Files:**
- Create: `packages/core/src/genui/wire/text-edit.ts`, `packages/core/src/genui/wire/text-edit.test.ts`
- Modify: `packages/core/src/genui/wire/print.ts` (add `{ ids: false }`), `packages/core/src/index.ts`

- [ ] Read `print.ts` and the compiler's id-minting path first.
- [ ] Failing tests: `applyTextEdits` exact-match replace; zero matches → issue quoting the `old`; two matches → issue saying "ambiguous, include more context"; multiple edits applied in order, later edits see earlier results. Round-trip: `printWire(tree, {ids:false})` → edit one prop → `recompileWithIdentity` → untouched nodes keep their previous ids (assert by structural position), edited node keeps its id (prop-only change), a node whose element was rewritten inside the span gets a fresh id.
- [ ] Implement. Identity algorithm: diff the printed source against the edited text by the known replacement spans (we applied them, so spans are exact); nodes whose printed range lies entirely outside every span inherit their old id by order; others mint.
- [ ] Tests green; commit `feat(core): old/new text edits with span-derived identity`.

### Task 3: Checking layer

**Files:**
- Create: `packages/apps/src/checking/types.ts`, `packages/apps/src/checking/layer.ts`, `packages/apps/src/checking/facts.ts`, `packages/apps/src/checking/checking.test.ts`
- Modify: `packages/apps/src/index.ts` (export types), `packages/vendo/src/server.ts` (thread `AppsConfig.checks`)

- [ ] Read `packages/apps/src/generation/validation/validate.ts` first — the fact checks to KEEP (compile completeness, tool-exists, schema-fit via existing catalog/prop machinery) move here as `Check`s; do NOT move the judgment checks (they die at cutover, Task 10).
- [ ] Failing tests: layer runs checks in parallel and flat-merges findings; a host-registered check's findings appear; fact checks produce teaching messages ("…real fields are: …"); a check that throws yields a `warn` finding naming the check, never a crash.
- [ ] Implement; commit `feat(apps): plug-in checking layer with built-in fact checks`.

## Wave 1 — the actors (3 tasks, parallel; each depends only on Wave 0)

### Task 4: The brain

**Files:**
- Create: `packages/apps/src/generation/brain.ts`, `packages/apps/src/generation/brain.test.ts`, `packages/apps/src/generation/prompts/brain.ts`
- Modify: `packages/apps/src/persistence.ts` (session on the app record, stripped server-authoritatively like `pinDrift`)

- [ ] Read `packages/apps/src/generation/engine.ts` (model call plumbing, `cacheableGenerationMessages`, `modelCallParams`) and `runtime.ts` session/persist seams first.
- [ ] Failing tests (scripted model, as `engine.test.ts` does): tiny ask → `direct` with valid wire; normal ask → `plan` parsed through `compilePlan`; impossible ask → `cannot`; small edit turn → `edits`; structural edit turn → `amend`; malformed plan → one retry with the issues appended, then failure; session appended per turn, capped at 20, oldest dropped; forged `session` on an incoming document is stripped.
- [ ] Prompt (`brain.ts`): the plain-English one-pager from the spec discussion — role, direct-path rule, plan dialect reference, component menu one-liners, tool one-liners, the handful of rules (never invent data; `cannot` instead of faking; escapes earned; distinct purposes). Simple v1; marked `// Yousef iterates on this text — keep it one screen`.
- [ ] Implement; commit `feat(apps): the brain — per-app session, plan/direct/cannot/edit outcomes`.

### Task 5: Skeleton + renderer pending states (UI — design pass + browser proof required)

**Files:**
- Create: `packages/apps/src/generation/skeleton.ts`, `packages/apps/src/generation/skeleton.test.ts`
- Modify: `packages/ui/src/tree/renderer.tsx` (pending placeholder rendering), `packages/ui/src/wire-types.ts` if the pending prop needs the wire mirror

- [ ] Read `renderer.tsx` and how partial trees render today (paint lane path) first.
- [ ] Failing tests: plan → tree with container chrome (tab titles present), one placeholder node per leaf, slot map group→nodeId; streaming: `skeletonFromPlan` on a prefix plan (some groups) yields a subset that is a prefix of the full skeleton (stable ids so the UI grows, never re-mounts).
- [ ] Renderer: placeholder nodes render the composite's loading state (shimmer); load the `design` skill for the shimmer/empty treatment; verify visually in demo-bank with a hardcoded plan; screenshots in the PR.
- [ ] Commit `feat(apps,ui): deterministic skeleton from plan with streaming placeholder states`.

### Task 6: The reviewer

**Files:**
- Create: `packages/apps/src/checking/reviewer.ts`, `packages/apps/src/checking/reviewer.test.ts`, `packages/apps/src/generation/prompts/reviewer.ts`

- [ ] Failing tests (scripted model): reviewer receives request + printed app + resolved sample data, returns findings parsed from a strict tool call (`report_findings`, flat schema: `[{severity, where, message}]`); model returning nothing → empty findings (never a crash); findings flow through the checking layer like any check.
- [ ] Prompt: one page — judge invented data, dishonest tool use (payment ≠ message channel), dead buttons, sections that don't answer the ask; simple v1, one screen.
- [ ] Commit `feat(apps): AI reviewer as a checking-layer adapter`.

## Wave 2 — filling and the rare lanes (2 tasks, parallel)

### Task 7: Fill workers + queries-early + fix loop

**Files:**
- Create: `packages/apps/src/generation/fill.ts`, `packages/apps/src/generation/fill.test.ts`, `packages/apps/src/generation/prompts/worker.ts`
- Modify: `packages/apps/src/generation/skeleton.ts` (splice)

- [ ] Read `stages/parallel.ts` (fragment assembly precedent) and the tool-execution path used by the data-verify pass first — then delete-as-you-go happens in Task 10, not here.
- [ ] Failing tests (scripted model): one worker call per group, prompt contains ONLY its group + its referenced queries' shapes/samples + its components; fragments spliced into the right slots; concurrency dial respected (assert ≤N in flight); read-risk queries executed at plan time, results in prompts and returned for first-open reuse; a group whose fragment fails fact checks gets a fix-it edit turn (×2) with the finding as instruction, then a `warn` finding and the placeholder stays (section-sized failure, never app-sized).
- [ ] Worker prompt: the blinkered one-pager. Commit `feat(apps): parallel group fill with fix-it loop`.

### Task 8: Plan-declared islands, automations, sandbox bind-after-build

**Files:**
- Modify: `packages/apps/src/generation/engine.ts` (island pass callable from plan), `packages/apps/src/runtime.ts` (automation + box paths take the plan's `server` declaration; box flow reordered)
- Test: extend `packages/apps/src/escalation-ladder.test.ts` scenarios onto the new entry points (new file `packages/apps/src/generation/lanes.test.ts`; the old test file is deleted in Task 10 with the judge)

- [ ] Read `runtime.ts` `automate()`/`graduate()` and `box-agent.ts` first.
- [ ] Failing tests: plan with `island` → island pass runs with existing screening (prepareIslands + smoke render untouched); plan with `server.kind: steps|agentic` → existing `planAutomation` path armed, results collection bound (all reused); plan with `server.kind: box` → independent groups fill immediately, dependent groups wait; scripted box reports `{ functions: [{name, sampleOutput}] }` → dependent groups fill against the sample shapes, once, no retry ceremony; box failure → dependent slots become honest failure placeholders, rest of the app stands; flags off → `cannot` at plan validation, not a throw after generation.
- [ ] Commit `feat(apps): island/automation/box lanes driven by the plan; box binds after build`.

## Wave 3 — cutover (2 tasks, serial)

### Task 9: Expressions

**Files:**
- Create: `packages/core/src/genui/expr.ts`, `packages/core/src/genui/expr.test.ts`
- Modify: renderer bind-resolution (`packages/ui/src/tree/` where `$path` resolves), fact checks (parse + fields exist)

- [ ] Failing tests: parse/evaluate the grammar (locked above) over sample data; unknown field → fact finding; type mismatch (sum over strings) → fact finding; renderer resolves `$expr` live (re-evaluates when data changes).
- [ ] Commit `feat(core,ui): live-computed expressions`.

### Task 10: Rewire runtime, execute the kill list, prove end to end

**Files:**
- Modify: `packages/apps/src/runtime.ts` (create/edit route to the brain), `packages/vendo/src/server.ts` (config: `fillConcurrency`, `checks`, rename `paint`→`fill`)
- Delete: `serverWorkRung` + signal regexes + carve-outs, the paint lane, `stages/parallel.ts` + outline, `pipeline` flags (all 7), island-repair budget, structured repair (`stages/repair.ts` fix-menu machinery), end pass + rebind + data-verify passes (`stages/verify.ts`), `<Edit>` ops grammar usage (`compileWirePatch` call sites; core keeps the function only if rebase replay still needs it — if rebase replays via text edits, delete it from core too), deterministic law-1 literal check + capability-substitution gate + their tests, `escalation-ladder.test.ts`, empty-document + rooted-render validators
- [ ] Green baseline first: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` on the branch before starting.
- [ ] Rebase replay (`runtime.ts` pins.rebase) switched to brain edit turns; its tests updated ONLY where they encode the ops grammar (state this out loud in the PR).
- [ ] Grep-proof the kill list: `serverWorkRung|tier0Contract|regionParallel|structuredRepair|endPass|capabilitySubstitution|literalDataIssues|compileWirePatch` → zero hits in `packages/` source (allowing the rebase exception if kept).
- [ ] Full gate green: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **The one-prompt proof** (real browser, demo-bank, Yousef's Vendo Cloud account, screenshots + GIF in the PR): prompt = "An invoices workspace: overview tab with headline totals (computed) and a monthly chart, a second tab listing overdue invoices worst-first, and remind me every Friday to chase the worst ones." Must show: skeleton ≤ ~5s with tab chrome → groups lighting up progressively → computed total present and live → automation armed with grants surfaced → then TWO edits: "make the overdue table show client emails too" (small, fast) and "add a payments tab with a history table" (structural: plan amendment, skeleton grows, new group fills). One continuous session, no retries hidden.
- [ ] Cutover PR `generation-rebuild` → `main` with the proof attached; auto-merge NOT armed — merge on green checks (this is the swap; per approved plan it lands when green, no second ask).

---

## Self-review notes

- Spec coverage: idea→Tasks 4–7; creating→1,4,5,7; editing→2,4; checking→3,6; computed values→9; sandbox→8; kill list→10; what-stays→untouched by construction; measurement gates→deferred by Yousef except the one-prompt proof (Task 10).
- Deferred explicitly (not gaps): full bench replay + reviewer incident exam (gates deletion is at cutover per Yousef's later ruling — the deterministic judgment checks die in Task 10 with the reviewer in place; the recorded-incident replay runs later on his call), catalog search, prompt polish.
- Type consistency: `AppPlan`/`PlanGroup`/`Finding`/`BrainOutcome`/`TextEdit` defined once above; all tasks reference these exact names.
