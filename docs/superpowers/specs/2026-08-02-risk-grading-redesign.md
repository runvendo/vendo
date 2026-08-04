# Risk grading redesign: no name guessing, ungraded asks, `confirmEach`

**Status:** settled with Yousef 2026-08-02, awaiting his sign-off. Grew out of the
2026-07-31 Executor deep look, which surfaced that `payInvoice` classifies `write`
and runs un-gated on installs that never ran the AI judge.

## The problem

Risk labels today have a keyword floor: `DESTRUCTIVE_WORDS` / `READ_WORDS` in
`packages/actions/src/sync/common.ts` and `DESTRUCTIVE_TOKENS` / `READ_VERBS` in
`packages/actions/src/connectors/composio-risk.ts`. Name lists have two failure
modes, both silent:

- **Guaranteed misses.** English is infinite; *pay, charge, refund, approve,
  merge, publish* aren't on the list. A missed word means a dangerous tool runs
  with no gate — and nobody is told.
- **False safety.** "Destructive actions require approval" reads as coverage.
  The list's existence is what stops a host from auditing the labels.

Deleting the list alone makes things *worse* (the destructive-word list only ever
adds asks). The real defect is that **an ungraded catalog behaves identically to a
graded one.**

## Decisions (all settled — do not re-litigate)

### D1 — All name-based inference dies

No code path may conclude anything from a tool's *name*. Delete:

- `DESTRUCTIVE_WORDS`, `READ_WORDS`, `containsWord`-based grading in
  `packages/actions/src/sync/common.ts` (`extractedRisk`, `trpcRisk`, `graphqlRisk`)
- `DESTRUCTIVE_TOKENS`, `READ_VERBS` slug scanning in
  `packages/actions/src/connectors/composio-risk.ts`

### D2 — Only these may grade a tool, in priority order

1. **Human** — `overrides.json`. Always wins.
2. **AI judge** — the existing judgment pass (reads handler source, verbatim
   evidence, independent skeptic, harden-instant / loosen-queued). Unchanged.
3. **Protocol facts only** — true by definition, never inferred:
   - HTTP method `DELETE` → `destructive`
   - GraphQL/tRPC `mutation` → at least `write` (never `read`)
   - Composio upstream `destructiveHint` → `destructive`, `readOnlyHint` → `read`
   - HTTP `GET` alone is **not** sufficient for `read` (GETs that mutate exist);
     an un-judged GET is `ungraded`.
4. **Nothing above spoke** → `ungraded`.

### D3 — `ungraded` is a first-class risk state that asks

- `RiskLabel` (`packages/core/src/tools.ts:33`) gains `"ungraded"`. Explicit
  value, not absence — schema-visible, fail-closed.
- Guard default policy treatment: `ungraded` behaves like `destructive` — asks.
  This is a guard-level default (like today's `default → run` fallthrough), not
  an init-written policy rule, so hand-wired servers get it too.
- Judge/overrides replace `ungraded` with a real grade; a graded catalog never
  shows the state.
- Policy rules may match `risk: ungraded` (a host can consciously loosen it;
  that's their call, in writing).

### D4 — Not-knowing must be felt

- `vendo doctor` reports the count plainly:
  `catalog: 34/61 tools ungraded — run \`vendo sync\` with a model key to grade`
  (error code `E-TOOLS-003`, anchored on the verify page).

  **Amended at build time (2026-08-02):** this bullet originally said "`vendo
  status` and `vendo doctor`". There is no `vendo status` command — the CLI is
  `try / init / login / doctor / sync / eject / knowledge / mcp / cloud /
  config` — so doctor is the whole status surface, and no command was invented
  to match the prose.
- `vendo init` unchanged in shape (one consent question, judge on the ladder);
  when the judge is skipped, init says what the consequence is: ungraded
  mutations will ask until the catalog is graded.

### D5 — `critical` → `confirmEach`

Behavior is unchanged and stays exactly as shipped (`packages/guard/src/guard.ts`
pipeline head): checked before rules/grants/judge; grants, rules, judge, and
presets can never suppress it; each call needs its own input-bound, single-use
approval. Rename only, because "critical" reads as a severity rung and it is not
one — it is a governance flag orthogonal to the risk grade:

- grade = **fact** about the action (judge must evidence it): payment = `write`,
  data export = `read`, bulk archive = `destructive`
- `confirmEach` = **who must be present**: payment and export carry it; the
  archive doesn't (delegatable to automations via standing grants)

Rename everywhere (descriptor field, judge rubric/fields, guard pipeline,
`decidedBy: "critical"` → `"confirmEach"`, docs). Host-authored files
(`overrides.json`, `judgments.json`) accept `critical` as a read alias
indefinitely; writers emit `confirmEach`. Persisted-data tags are the sanctioned
exception to the no-suffixes law, and this is the same shape: read old, write new.

## What does NOT change

- Grades `read`/`write`/`destructive` stay tunable: policy rules, standing
  grants, presets, breakers all work as today.
- The judge (prompts, skeptic, direction rule), `audience`, `disabled`,
  `semantics`, away-run grant law, automations grant capture: untouched.
- Zero-key rule intact: everything functions with no model key — the difference
  is felt (asks) instead of hidden.

## Acceptance criteria

1. `grep -rn "DESTRUCTIVE_WORDS\|READ_WORDS\|DESTRUCTIVE_TOKENS\|READ_VERBS" packages/`
   returns nothing.
2. A synced catalog with no judge run: every non-protocol-graded tool is
   `ungraded`; calling any ungraded tool parks with `decidedBy: "default"` ask;
   `vendo doctor` reports the ungraded count (amended from `vendo status`,
   which does not exist — see D4).
3. `payInvoice` (POST, no judge): `ungraded` → asks. After the judge runs:
   `write` + `confirmEach` → still asks, every call, grants never consulted.
4. A GET route with no read-shaped anything and no judge: `ungraded` (not `read`).
5. Old `overrides.json`/`judgments.json` files using `critical:` load unchanged.
6. Corpus (`pnpm corpus`) re-baselined: extraction grades assert protocol facts
   + ungraded, not word-list outputs.
7. `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.

## Out of scope

- Judge rubric changes (payment→`confirmEach` is already in the rubric).
- Any UI redesign beyond status/doctor lines and rendering the `ungraded` label
  where risk already renders.
- Connector-error sanitization (dropped per Yousef 2026-08-02).
