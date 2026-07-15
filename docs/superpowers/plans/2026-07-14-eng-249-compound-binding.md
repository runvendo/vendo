# ENG-249: Compound Tool Binding + Per-Step Guard + capabilities.json — Implementation Plan

> **For agentic workers:** execute task-by-task in order. Each task ends in a commit; the orchestrator reviews every diff before the next task starts. Steps use checkbox (`- [ ]`) syntax for tracking. This is the SECURITY-SENSITIVE core of the extraction project — when a step here conflicts with something you'd rather do, the step wins; if a step looks wrong, STOP and raise it instead of improvising.

**Goal:** A first-class `compound` binding kind — ordered steps over primitive tools — loaded from a new agent-authored `.vendo/capabilities.json` (`vendo/capabilities@1`), executed so that every step re-enters the guard-bound registry (per-step approvals/grants/breakers/audit), with no second execution path.

**Architecture:** `packages/actions` gains the format (`CompoundBinding`, `CapabilitiesFile`), a small pure step-walker (`runtime/steps.ts`, semantics matching automations' — parity-tested), and a compound executor (`runtime/compound.ts`) that dispatches each step through an `invokeTool` callback. The umbrella (`packages/vendo`) wires `invokeTool` to the guard-bound registry after `guard.bind(actions)`. Load-time validation quarantines (disables) any compound that fails semantic checks. Contract amendment to `docs/contracts/04-actions.md` (+ one constant line in `01-core.md`) ships as a separate PR gated on Yousef.

**Tech stack:** TypeScript, zod, jsonata (new dep for `@vendoai/actions`; automations already uses it), vitest. Layering: actions imports core ONLY (dependency-guard enforces).

**Spec:** `docs/superpowers/specs/2026-07-14-extraction-survives-real-apps-design.md` (§2 Compound tools; decisions LOCKED). Linear: ENG-249.

---

## Locked design decisions (do not re-litigate; raise, don't change)

1. **One execution path.** A compound executes ONLY by walking steps through `config.invokeTool` (wired by the umbrella to `guard.bind(actions).execute`). No `invokeTool` configured → the compound returns `{ status:"error", code:"not-implemented" }` and performs NO work. The walker never calls `executeHost`/connectors/registries directly.
2. **Steps reference primitive host/connector tools only.** A step `tool` must resolve, at load, to a registered non-compound, non-disabled host or connector tool. `fn:*` refs, compound refs (incl. self), and `add()`-registry capability tools are rejected. The walker re-checks the target kind before EVERY invoke (defense in depth against post-load `add()` shadowing).
3. **Descriptor risk = max of step risks** (`read < write < destructive`), computed on POST-override-merge step descriptors, compared to the POST-override-merge compound risk. Mismatch (either direction) fails validation.
4. **Semantic validation failures quarantine, never brick, never degrade.** A compound failing any semantic check loads DISABLED (name reserved for collision detection, absent from `descriptors()` and dispatch). File-level failures (malformed JSON, schema mismatch, wrong `format`) throw loudly, exactly like `tools.json`/`overrides.json` today.
5. **Per-step approvals in v1.** A step's `pending-approval` outcome halts the walk and becomes the compound call's outcome (same `approvalId`). Resume happens when the SAME logical call (same `call.id`, same args, same subject/session) is re-executed: completed steps are NOT re-run; the parked step is re-issued VERBATIM (original step `call.id` + args) so guard's single-use approval replay (`#consumeApprovedCall`) matches. Batch-approval UX is explicitly out of scope.
6. **Walker semantics match automations'** (`packages/automations/src/engine.ts` `continueSteps`): sequential steps; `if` JSONata predicate skips the step; `forEach` yields an array (error if not; cap 1000 items — same constant); `args` values are JSONata expressions; expression/validation errors halt with `code:"validation"`; `blocked`/`error` outcomes halt; step outputs land in `steps.<id>` (array of outputs for forEach steps). Parity is enforced by a shared fixture table run against BOTH implementations (Task 7).
7. **Compound step expressions see `{ args, steps, item }`** — `args` is the compound call's arguments (automations bind `event` instead; the walker kernel parameterizes the root binding). This is a format decision ENG-250 depends on; it is flagged in the amendment PR for Yousef.
8. **`.vendo/capabilities.json` is agent-authored and merged at load like overrides**; deterministic `tools.json` never carries compounds (its schema rejects `kind:"compound"` entries loudly). `overrides.json` entries apply field-wise to compound descriptors by name, same merge rule as today.
9. **ctx hygiene:** before invoking a step, the compound executor STRIPS `grant` from the ctx it passes to `invokeTool` (a compound-level grant must never ride into a step's `actAs`); everything else (`principal`, `venue`, `presence`, `sessionId`, `appId`, `trigger`, `requestHeaders`, `mcpConsent`) passes through unchanged so guard re-decides each step in the true context.
10. **In-memory resume state** keyed by `subject|sessionId|call.id`, bounded (max 1000 entries, 60-min TTL sweep — mirror guard's breaker-map sweep). Lost state (process restart) means the compound re-walks from step 0 on re-execution; single-process durability is the stated v0 model (same assumption as guard's `AsyncLock`). Document in PR notes.

## Format: `vendo/capabilities@1` (lock this shape; flag naming questions in the amendment PR, then align code to whatever Yousef signs off)

```jsonc
// .vendo/capabilities.json — agent-authored (refine engine), human-reviewed diffs, host-committed
{
  "format": "vendo/capabilities@1",
  "tools": [
    {
      // ToolDescriptor fields (01-core §4)
      "name": "host_invoice_send_flow",
      "description": "Create an invoice and email it to the customer",
      "inputSchema": { /* JSON Schema for the compound's own args */ },
      "risk": "write",                    // MUST equal max of step risks post-merge
      "critical": false,                  // optional, as any descriptor
      "binding": {
        "kind": "compound",
        "steps": [                        // core Step shape (01-core §11), 1..50 steps
          { "id": "create", "tool": "host_invoices_create", "args": { "amount": "args.amount" } },
          { "id": "send", "tool": "host_invoices_send", "if": "args.email != null",
            "args": { "id": "steps.create.id", "to": "args.email" } }
        ]
      },
      "disabled": false,                  // optional
      "note": "authored by vendo refine"  // optional
    }
  ],
  "briefs": [
    { "name": "bulk-paste", "text": "To paste a range, call host_cells_update per row…", "tools": ["host_cells_update"] }
  ]
}
```

Schema rules: file object and tool entries `.passthrough()` (generated artifact, additive evolution — same posture as `tools.json`); `steps` min 1 max 50; step `id`s unique within a compound; `briefs` entries `{ name: string min1, text: string min1, tools?: string[] }`, passthrough; `briefs` optional (default `[]`). Briefs are carried, validated, and exposed via a registry accessor — nothing consumes them yet (M5/M6 will).

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `packages/core/src/formats.ts` | modify | `+ export const VENDO_CAPABILITIES_FORMAT = "vendo/capabilities@1" as const;` |
| `packages/actions/src/formats.ts` | modify | `CompoundBinding` (+schema), `ToolBinding` union gains it; `toolsFileSchema` rejects compound entries; `CapabilityBrief`, `CapabilitiesFile` (+schemas) |
| `packages/actions/src/runtime/steps.ts` | create | Pure step-walker kernel: injected `evaluate`/`invoke`, resume-point in/out, forEach cap 1000 |
| `packages/actions/src/runtime/compound.ts` | create | `validateCapabilities()` (shared load+write validation), quarantine logic, compound executor with resume map + ctx hygiene |
| `packages/actions/src/runtime/registry.ts` | modify | Config `+ capabilities?, invokeTool?`; read `.vendo/capabilities.json`; register compounds (dispatch `kind:"compound"`); route execution to compound executor |
| `packages/actions/src/index.ts` | modify | Export new types/schemas + `validateCapabilities` |
| `packages/actions/package.json` | modify | `+ jsonata ^2.0.5` |
| `packages/vendo/src/server.ts` | modify | Wire `actionsConfig.invokeTool = (call, ctx) => boundTools.execute(call, ctx)` after `guard.bind` |
| `docs/contracts/04-actions.md` | modify | Amendment: capabilities.json section + "§6 Compound tools (normative)" |
| `docs/contracts/01-core.md` | modify | Amendment: add the format constant to the §1 list |
| `packages/actions/src/formats.test.ts` or nearby | create/extend | Schema tests |
| `packages/actions/src/runtime/steps.test.ts` | create | Kernel unit tests |
| `packages/actions/src/runtime/compound.test.ts` | create | Load/merge/quarantine/execution/resume tests |
| `packages/actions/src/security/compound-no-bypass.test.ts` | create | Adversarial no-unguarded-path suite |
| `packages/vendo/src/compound.e2e.test.ts` | create | Guard-visibility e2e through real `createVendo` composition |
| `packages/vendo/src/compound-parity.test.ts` | create | Shared fixture table vs automations engine |

Check `packages/vendo/src/type-surface.test.ts` after export changes (PR #145 added a tsc-backed type-surface test; new exports may need registering there).

---

### Task 1: Contract amendment (separate PR, gated on Yousef)

**Files:** `docs/contracts/04-actions.md`, `docs/contracts/01-core.md`

- [ ] **Step 1:** On a fresh branch `yousefh409/eng-249-contract-amendment` cut from `origin/main`, amend `docs/contracts/04-actions.md`:
  - In §1, after the overrides subsection, add subsection **`.vendo/capabilities.json` (agent-authored, reviewed diffs)** with the JSONC example above and the merge rule: loaded alongside overrides; compounds are additional tools; name collisions with `tools.json`/connectors are a `conflict` error; `overrides.json` applies field-wise to compounds by name; semantic-validation failures quarantine the entry (disabled, never executes, never degrades); `tools.json` stays deterministic and never carries compounds.
  - Add new section **§6 Compound tools (normative)**: the `compound` binding kind (steps reuse core §11 `Step`; expressions see `{ args, steps, item }`); descriptor risk MUST equal max of post-merge step risks; steps reference primitive host/connector tools only (no `fn:`, no compounds, no capability tools); **execution routes every step through the guard-bound registry via the umbrella-wired `invokeTool` seam — grants, approvals, breakers, scanners and audit see every real call; there is no second execution path; absent seam → `not-implemented`, no work performed**; per-step approvals in v1 (a step's park becomes the compound's outcome; re-executing the same logical call resumes without re-running completed steps); batch-approval is an explicit follow-up.
  - In §2, extend the `createActions` config listing with `capabilities?` and `invokeTool?` and a one-line note that the umbrella wires `invokeTool` to the guard binding (09 §2).
- [ ] **Step 2:** In `docs/contracts/01-core.md` §1, add `export const VENDO_CAPABILITIES_FORMAT = "vendo/capabilities@1";` to the constants list. No other core contract text changes (Step shape is reused as-is).
- [ ] **Step 3:** Add an explicit **"Open questions for sign-off"** block at the bottom of the 04 amendment diff (PR description, not the contract): (a) root binding name `args` vs automations' `event`; (b) passthrough vs strict entry schemas; (c) quarantine-on-semantic-failure vs boot error; (d) brief shape `{name, text, tools?}`. Recommendation stated for each (as above).
- [ ] **Step 4:** Commit (`docs: amend 04-actions with compound binding + vendo/capabilities@1 (ENG-249)`), push, open PR titled `[ENG-249] Contract amendment: compound binding kind + vendo/capabilities@1` marked **DO NOT MERGE until Yousef signs off**. STOP — orchestrator reviews and posts it to Yousef.

### Task 2: Formats — schemas first

**Files:** `packages/core/src/formats.ts`, `packages/actions/src/formats.ts`, tests beside existing schema tests.

- [ ] **Step 1 (failing tests):** schema tests asserting: valid capabilities file parses; `format` other than `vendo/capabilities@1` rejects; compound with 0 steps rejects; 51 steps rejects; duplicate step ids reject; unknown extra keys on entries are ACCEPTED (passthrough); `toolsFileSchema` REJECTS a tools.json entry whose binding kind is `compound` (error message points at capabilities.json); briefs validate; `ToolBinding` union type accepts compound (type-level `satisfies` checks like the existing ones).
- [ ] **Step 2:** Run, confirm failures.
- [ ] **Step 3 (implement):**
  - core: add `VENDO_CAPABILITIES_FORMAT`.
  - actions `formats.ts`:
    ```ts
    import { stepSchema, type Step, VENDO_CAPABILITIES_FORMAT } from "@vendoai/core"; // stepSchema already exists in core (triggers.ts)

    export interface CompoundBinding { kind: "compound"; steps: Step[]; }
    export const compoundBindingSchema = z.object({
      kind: z.literal("compound"),
      steps: z.array(stepSchema).min(1).max(50),
    }).passthrough()
      .refine((b) => new Set(b.steps.map((s) => s.id)).size === b.steps.length,
        { message: "compound step ids must be unique" }) satisfies z.ZodType<CompoundBinding>;

    export type ToolBinding = RouteBinding | OpenApiBinding | CompoundBinding;
    // toolBindingSchema: add compoundBindingSchema to the discriminated union.
    // toolsFileSchema: entries use a refine rejecting binding.kind === "compound"
    //   ("compound tools live in .vendo/capabilities.json — tools.json is deterministic").

    export interface CapabilityBrief { name: string; text: string; tools?: string[]; }
    export type CompoundTool = ToolDescriptor & { binding: CompoundBinding; disabled?: boolean; note?: string };
    export interface CapabilitiesFile {
      format: typeof VENDO_CAPABILITIES_FORMAT;
      tools: CompoundTool[];
      briefs?: CapabilityBrief[];
    }
    ```
    with matching zod schemas (`capabilityBriefSchema`, `compoundToolSchema`, `capabilitiesFileSchema`, all passthrough). NOTE: `stepSchema`/`Step` must be exported from core's root — verify; they are (via triggers.ts / index).
- [ ] **Step 4:** Tests pass. `pnpm --filter @vendoai/core --filter @vendoai/actions test`, `pnpm typecheck`.
- [ ] **Step 5:** Commit `feat(actions): compound binding + vendo/capabilities@1 formats (ENG-249)`. STOP for review.

### Task 3: Step-walker kernel

**Files:** create `packages/actions/src/runtime/steps.ts` + `steps.test.ts`.

- [ ] **Step 1 (failing tests):** drive the kernel with stub `evaluate`/`invoke`:
  - sequential execution, outputs recorded under `steps.<id>`;
  - `if` false → skipped entirely (no invoke, no outcome entry);
  - `forEach` non-array → validation error halting the walk; > 1000 items → validation error (message matches automations': `step <id> forEach exceeds 1000 items`); item outputs collected into an array under `steps.<id>`;
  - args mapping: each `args` value evaluated against the root context `{ args, steps, item }`;
  - invoke outcome `error`/`blocked` → walk halts, outcome + halted step surfaced;
  - invoke outcome `pending-approval` → walk halts with a RESUME POINT `{ stepIndex, forEachIndex?, iterationItems?, iterationOutputs?, stepOutputs, pendingCall }` where `pendingCall` is the exact ToolCall issued;
  - resuming from a resume point re-issues `pendingCall` VERBATIM first (same id/args), then continues (mid-forEach continues at the next index; plain step continues at the next step);
  - evaluation errors (throwing evaluate) → validation-error halt.
- [ ] **Step 2:** Run, confirm failures.
- [ ] **Step 3 (implement):** pure module, no I/O, no jsonata import (kernel takes `evaluate: (expr, context) => Promise<unknown>`; the COMPOUND EXECUTOR supplies jsonata — keeping the kernel dependency-free and parity-testable). Signature sketch:
  ```ts
  export interface StepResumePoint {
    stepIndex: number;
    forEachIndex?: number;
    iterationItems?: Json[];
    iterationOutputs?: Json[];
    stepOutputs: Record<string, Json>;
    pendingCall: ToolCall;               // re-issued VERBATIM on resume
  }
  export type StepWalkResult =
    | { status: "ok"; stepOutputs: Record<string, Json> }
    | { status: "halted"; outcome: ToolOutcome; step: Step }            // error | blocked
    | { status: "parked"; approvalId: string; resume: StepResumePoint };
  export function walkSteps(options: {
    steps: Step[];
    root: Record<string, Json>;                    // { args } for compounds; kernel spreads it into eval context with { steps, item }
    evaluate(expression: string, context: Record<string, Json | undefined>): Promise<Json>;
    invoke(call: ToolCall): Promise<ToolOutcome>;  // caller mints call ids
    newCallId(): string;
    resumeFrom?: StepResumePoint;
  }): Promise<StepWalkResult>;
  ```
  Mirror `continueSteps` control flow (engine.ts:536-620) faithfully — same ordering of if→forEach→args→invoke, same error text shapes — WITHOUT the run-record/stopped/park persistence concerns.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(actions): pure step-walker kernel matching automations semantics (ENG-249)`. STOP for review.

### Task 4: capabilities load, merge, validation, quarantine

**Files:** create `packages/actions/src/runtime/compound.ts`; modify `registry.ts`; `compound.test.ts`.

- [ ] **Step 1 (failing tests):**
  - registry with `capabilities` injected (and separately via `dir` reading `.vendo/capabilities.json` from a temp dir): compound appears in `descriptors()` with its descriptor fields;
  - malformed capabilities JSON / wrong format → loud `VendoError("validation")` naming the file;
  - name collision with a tools.json tool or connector tool → `conflict` throw (both directions);
  - override by compound name changes description/risk — and a risk override that breaks the max-invariant quarantines;
  - QUARANTINE (absent from descriptors AND dispatch — executing returns `not-found`): step tool unknown; step tool is another compound; step tool is `fn:x`; step tool is an `add()`-registry tool; step tool disabled (via override or `disabled:true`); declared risk ≠ computed max (test both under- and over-declaration; step risks post-override);
  - disabled compound (`disabled: true` in file or override) reserves its name (collision still detected) but doesn't execute;
  - `validateCapabilities(file, primitiveDescriptors)` exported and returns per-tool errors (the write-side seam ENG-250 will call) — load path uses the same function.
- [ ] **Step 2:** Run, confirm failures.
- [ ] **Step 3 (implement):** in `loadHost()`, read `capabilities.json` alongside the other two; in `load()`, after host tools + connectors + added registries are registered, validate each compound against the assembled primitive table (host+connector dispatch entries only) via `validateCapabilities`; register valid ones as `{ kind: "compound", descriptor, tool }` dispatch entries; quarantined/disabled ones reserve the name via the existing `register(name, source, undefined)` path. Risk order helper: `read=0, write=1, destructive=2`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(actions): load + validate + quarantine .vendo/capabilities.json (ENG-249)`. STOP for review.

### Task 5: compound execution — invokeTool seam, resume map, ctx hygiene

**Files:** `compound.ts`, `registry.ts` (execute path + `RegistryConfig.invokeTool`), `compound.test.ts`.

- [ ] **Step 1 (failing tests):** with a stub `invokeTool` recording `(call, ctx)`:
  - happy path: two steps execute IN ORDER through invokeTool with mapped args; compound outcome `ok` with output `{ steps: <stepOutputs> }` (the full map — simple, deterministic v1 output shape);
  - NO invokeTool configured → `{ status:"error", code:"not-implemented" }`, stub fetch/connectors NEVER touched;
  - args not an object → validation error (same guard as executeHost);
  - step pending-approval: compound returns `{ status:"pending-approval", approvalId }` (the step's); re-execute SAME call.id+args → step 1 not re-invoked, parked step re-issued with its ORIGINAL call id and args; then walk completes;
  - resume isolation: different subject or different sessionId with the same call.id does NOT hit the resume entry (fresh walk); same call.id with DIFFERENT args → fresh walk;
  - terminal outcomes (ok/error/blocked) clear the resume entry; entry count bounded at 1000 with oldest eviction; entries older than 60 min swept;
  - ctx hygiene: incoming ctx with `grant` (compound-level) → step invocations receive ctx WITHOUT `grant`; `mcpConsent`, `requestHeaders`, `principal`, `venue`, `presence`, `appId`, `trigger`, `sessionId` pass through unchanged;
  - defense in depth: invokeTool that would resolve to a compound (simulate a registry where a step name now maps to a compound after `add()` shenanigans) — the walker refuses before invoking (checks the load-time primitive table AND rejects step tools not in it at execution time).
- [ ] **Step 2:** Run, confirm failures.
- [ ] **Step 3 (implement):** compound executor builds jsonata `evaluate` (import jsonata in compound.ts, add the dep), mints step call ids (`call_<uuid>` like automations), maintains the resume map (module-level per-registry instance, in the createActions closure — NOT global), keys `subject|sessionId|call.id`, stores an args hash (reuse core's `sha256Hex(canonicalJson(args))`) to detect arg drift. Registry `execute()` routes `kind:"compound"` dispatch entries here.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(actions): compound execution through the invokeTool guard seam (ENG-249)`. STOP for review.

### Task 6: umbrella wiring + guard-visibility e2e + adversarial suite

**Files:** `packages/vendo/src/server.ts`; create `packages/vendo/src/compound.e2e.test.ts`, `packages/actions/src/security/compound-no-bypass.test.ts`.

- [ ] **Step 1:** Wire the seam in `createVendo` (server.ts ~line 664): add `invokeTool` to the `actionsConfig` object type and assign after `const boundTools = guard.bind(actions);`:
  ```ts
  actionsConfig.invokeTool = (call, ctx) => boundTools.execute(call, ctx);
  ```
  (createActions reads config at execution time — the baseUrl comment documents this pattern.)
- [ ] **Step 2 (failing e2e tests, real `createVendo` composition with in-memory store + fixture capabilities/tools + counting `fetch` stub):**
  - **approval per step:** policy asks on `write`; compound (read step + write step) → read step executes and is audited; compound outcome pending-approval with the WRITE STEP's approvalId; `guard.approvals.pending()` shows the step tool + step args preview (NOT the compound); decide approve; re-execute same call.id → completes; audit trail contains per-step `tool-call` events with `decidedBy` for each step plus the approval event;
  - **grant:** standing grant for the step tool (minted via a remembered approval) → whole compound runs with no ask; step audit events show `decidedBy:"grant"` with `grantId`;
  - **breaker:** guard with `maxWritesPerRun: 1`; compound with two write steps → second step's decision is `ask` `decidedBy:"breaker"`, compound parks — breaker demonstrably sees individual steps;
  - **critical step:** step tool `critical: true` → asks EVERY run even with a standing grant (per-step critical semantics preserved through compounds).
- [ ] **Step 3 (failing adversarial suite — every test asserts the negative space):**
  - every host fetch performed during a compound walk has a matching guard `tool-call` audit event for the step tool: `fetchCount === auditedStepCallCount` (the no-unguarded-path theorem, asserted mechanically);
  - guard `policy.rules` block on the step tool → step blocked, compound halts blocked, zero fetches for that step;
  - compound whose descriptor was approved does NOT exempt steps: approve/grant on the COMPOUND name only → steps still ask individually;
  - away context (`presence:"away"`) without step grants → step parks (05 §6 downgrade applies per step); the compound-level grant attached by guard is NOT visible to the step's executeHost (actAs spy asserts `grant.tool === step tool` always, never the compound name);
  - `createActions` WITHOUT invokeTool but WITH a valid compound: execute → not-implemented, fetch count 0;
  - quarantined compound name execution → `not-found`, fetch count 0.
- [ ] **Step 4:** Implement until green. Full workspace test run.
- [ ] **Step 5:** Commit `feat(vendo): wire compound invokeTool to the guard binding + e2e/adversarial coverage (ENG-249)`. STOP for review.

### Task 7: automations parity fixtures

**Files:** create `packages/vendo/src/compound-parity.test.ts` (umbrella may import both packages; actions/automations may not import each other).

- [ ] **Step 1:** Build a fixture table of step programs (plain data): sequential outputs; `if` skip; `forEach` over event/args array; forEach > cap; non-array forEach; mid-walk error; mid-walk pending-approval + resume-to-completion; args JSONata referencing prior step outputs and `item`.
- [ ] **Step 2:** Run each fixture through (a) the automations engine (`createAutomationsEngine` with a stub `tools.execute` + host-event trigger, following `engine.test.ts` harness patterns, root binding `event`) and (b) the compound executor (root binding `args`), then assert IDENTICAL invoke sequences (tool, args), identical step-output propagation, and equivalent halt/park behavior.
- [ ] **Step 3:** Green. Commit `test(vendo): automations/compound step-semantics parity fixtures (ENG-249)`. STOP for review. (If parity reveals a semantic divergence, fix the COMPOUND side to match automations — automations is the reference implementation. Single-sourcing automations onto the kernel is a follow-up issue, not this PR.)

### Task 8: gate + PR

- [ ] **Step 1:** `pnpm build && pnpm test && pnpm typecheck && pnpm lint` — ALL green (lint includes dependency-guard; confirm actions still imports core only and jsonata is a declared dep). Check `packages/vendo/src/type-surface.test.ts` against new exports.
- [ ] **Step 2:** Push branch `yousefh409/eng-249-compound-binding`, open PR against `main`: summary, security invariants (the 10 locked decisions), the no-unguarded-path test evidence, the in-memory-resume restart caveat, link ENG-249 + the amendment PR. NEVER merge to main; NEVER merge the amendment without Yousef.
- [ ] **Step 3:** STOP — orchestrator does final review, Linear + worktree updates.

## Self-review notes (orchestrator)

- Spec §2 coverage: additive compound kind ✅ (T2); per-step guard via invokeTool, no second path ✅ (T5/T6); risk=max at load+write ✅ (T4, `validateCapabilities` is the write seam); capabilities.json merged like overrides ✅ (T4); walker semantics match automations, single-sourced *where practical* — kernel + parity tests now, automations adoption follow-up ✅ (T3/T7); contract amendment gated on Yousef ✅ (T1); ENG-250 unblocked by amendment PR + `validateCapabilities` export ✅.
- Done bar: e2e per-step approval/grant/breaker ✅ (T6 step 2); adversarial no-unguarded-path ✅ (T6 step 3); full gate ✅ (T8).
