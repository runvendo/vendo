---
"@vendoai/actions": minor
"@vendoai/agent": minor
"@vendoai/apps": minor
"@vendoai/automations": minor
"@vendoai/core": minor
"@vendoai/guard": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

Risk grading stops guessing from tool names, and a tool nobody has graded now
says so out loud instead of running.

**The word lists are gone.** Extraction used to read a tool's name against
`DESTRUCTIVE_WORDS` / `READ_WORDS` (and Composio slug verbs) to pick a grade.
English is infinite, so that list was guaranteed to miss — *pay, charge,
refund, approve, merge, publish* were never on it — and its existence is what
stopped anyone from auditing the labels. No code path concludes anything from
a tool's name anymore.

**Only facts grade a tool**, in priority order: a human (`overrides.json`), the
AI judge (which reads the handler source and quotes its evidence), then
protocol facts that are true by definition — HTTP `DELETE` is `destructive`, a
declared GraphQL/tRPC `mutation` is at least `write`, and Composio's own
`destructiveHint`/`readOnlyHint` say what they say. A `GET` is **not** a fact
about reading (GETs that mutate exist) and a `POST` is not a fact about
writing (search endpoints post).

**⚠️ Breaking behavior: an unjudged catalog now asks on mutations.** Anything
nothing above graded is the new first-class `ungraded` risk state, and the
guard's default treatment is to ask — like `destructive`, and at the guard
level rather than as an init-written rule, so a hand-wired server with no
policy config at all gets it too. On an install that never ran the AI judge
this is a real change: tools that used to run silently now park on an approval.
That is the point — `payInvoice` classified `write` and ran un-gated. Three
ways forward, and every one of them is a sentence:

- run `vendo sync` with a model key so the judge grades the catalog;
- grade the tools you care about by hand in `.vendo/overrides.json`;
- or decide, in writing, that you accept them:
  `{ "match": { "risk": "ungraded" }, "action": "run" }`.

`vendo doctor` reports the count plainly (`catalog: 34/61 tools ungraded`,
code `E-TOOLS-003`), and a keyless `vendo init`/`vendo sync` says what the
consequence is instead of implying the grades are real.

**`critical` is now `confirmEach`.** Behavior is unchanged — checked before
rules, grants, and the judge; none of them can suppress it; every call earns
its own input-bound, single-use approval. The old name read as a severity rung
and it is not one: the grade is a *fact* about the action (a payment is a
`write`), while `confirmEach` is *governance* — who must be present. They are
orthogonal, which is why a data export can be `read` + `confirmEach` and a bulk
archive can be `destructive` without it. Host-authored files
(`overrides.json`, `judgments.json`, `.vendo/tools.json`) accept `critical:` as
a read alias indefinitely; every writer emits `confirmEach`. In TypeScript,
`ToolDescriptor.critical` becomes `ToolDescriptor.confirmEach` and
`decidedBy: "critical"` becomes `decidedBy: "confirmEach"`.

**A standing denial means a person said no.** An ask that re-issues the same
call id is answered by the user's earlier no instead of minting a new card — but
only when a *human* wrote it: an abandoned chat turn, a timed-out embed, and the
TTL sweep reap the pending row and let the next issue ask again. A person's no
also voids any unconsumed yes still sitting on the same call, and a decision can
be taken back with `guard.approvals.revoke(id, principal)` / `DELETE
/approvals/:id` (the mirror of `grants.revoke`). Taking a decision back and
replaying an approval are the same one-time transition, so a call can never both
run and be voided — a take-back that arrives after the call was already
authorized answers `conflict` rather than reporting success. `Guard` grows one
optional method for the block that spends a yes WITHOUT replaying its call
(automations arms a standing grant from it): `spendApproval(id, principal)`
contends on that same transition and answers `spent` / `already-spent` /
`taken-back`. Custom Guards are unaffected — callers feature-detect it, exactly
like `abandonApprovals`.

Three known limits, all written down at the code that carries them. The receipt
is the only atomic step: an approval ROW has no guarded write (the store offers
`atomic` for threads, apps and generic rows only), so every marker on it is a
read followed by a write and something can move the row in between. Because the
transition winner is settled before any row write, the worst that costs you is a
stale marker — never an execution, since the transition a call would need is
already spent. And a custom `Guard` that does not implement the optional
`spendApproval` puts the automations grant mint back on that read-then-write
footing, where a revoke landing in the window can lose to the mint; the guard
that ships here has the seam. Third: when an automation's parked run resumes, its
standing grant is written just before the call and taken back if the call is not
authorized after all — every outcome the process lives through, a thrown one
included, but a hard kill in between leaves that grant behind and nothing sweeps
it. It shows up in `grants.list`, pinned to the tool's `descriptorHash`,
app-bound and away-only, and you can revoke it.

One consequence worth knowing: `descriptorHash` follows the field rename, so
approvals and grants persisted before the upgrade no longer match their tool's
new hash. They lapse into a re-ask, which is the fail-closed direction.
