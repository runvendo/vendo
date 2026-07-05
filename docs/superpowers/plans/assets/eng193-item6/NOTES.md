# ENG-193 item 6 — browser verification notes (Task 11: conversational steering)

Run: 2026-07-04, `pnpm --filter demo-accounting dev` via `infisical run ... -- pnpm --filter
demo-accounting dev`, judge ON (`FLOWLET_JUDGE_MODEL=claude-haiku-4-5`), landed on
`localhost:3002` (port 3000 was held by an unrelated worktree's own demo-accounting server —
left running, not killed; port 3005 was a stale server from this same worktree, killed and
restarted clean). State reset via `POST /api/demo/reset` before the run. Driven with Playwright
against the Assistant (`/assistant`) page, reusing item 5's fade choreography
(`docs/superpowers/plans/assets/eng193-item5/NOTES.md`).

## Beats verified

**(a) Fade grant minted, then a tighten rule beats it.**
Three real approvals-via-card of same-shape `sendClientMessage` calls (Rivera, then Harborview,
then a follow-up Rivera send — see "Anomaly: fade counts only card-approvals" below for why it
wasn't literally Rivera/Chen/Delgado back-to-back) produced the `FadeProposalCard` ("That's the
third time you've okayed send client message — want me to handle these without checking?"),
accepted via **Sounds good**. Trust screen confirmed the grant (`Send client message · any
input`). Said "Always check with me before sending client messages from now on." — this
surfaced as an approval card (heading "Always ask before this?"), NOT a receipt-style
auto-execute, because `cautionBreaker`'s own heuristic escalation fired on this call (see
anomaly below) — approved it, and the agent replied "Got it. I will always show you the draft
and wait for your approval before sending any client portal message" ("Set a rule" in the
activity trace). Asked to send Rivera another reminder: despite the standing fade grant, the
send raised an approval card again (**rule beats grant**, the core item-6 invariant) —
`01-rule-beats-grant.png`.

**(c, partial — done before (b) per the task's own note that the rule would beat the loosen
too) Trust screen Rules section.** Opened the Trust screen with the rule still live: "Rules"
section showed `Rule: "sending a client portal message"` with a **Remove rule** button, while
"Handled without asking" separately showed the grant — `04-trust-rules.png`. Clicked **Remove
rule**; the Rules section immediately dropped to "No standing rules yet." and the activity feed
logged "Removed a rule."

**(b) Loosen ceremony, then auto-execute.** With the rule removed, said "Stop asking me about
client messages." A full critical-tier ceremony card appeared: eyebrow "Always needs you",
title "Stop asking about this?", body listing `Tool name: sendClientMessage` / `Plain text:
sending client portal messages`, "This can't be undone.", buttons **Confirm stop asking about
this** / **Cancel** (no fade/receipt shortcut, as expected for a critical-tier tool) —
`02-loosen-ceremony.png`. Confirmed it; the agent replied "Done. I will send client portal
messages directly from now on without asking for your approval first" ("Loosened a rule" in the
activity trace). Follow-up sends to Chen, Delgado, and Harborview mostly auto-executed straight
to a "Sent client message" receipt with no approval card in between (e.g. "Send Delgado another
portal reminder... same as before" → "Done. Follow-up reminder sent to Antonio Delgado..." with
zero intervening card) — `03-loosen-active.png` captures this state (note: the same screenshot's
tail also shows one more `cautionBreaker` card mid-flight for Harborview — see anomaly below;
it was approved and the very next identical-shaped send then went straight through).

**(c) Trust screen after loosen.** Reopened the Trust screen: "Handled without asking" now
listed BOTH rows — `Send client message · any input` (the item-5 fade grant) and `sending
client portal messages` (the item-6 compiled-rule grant, `plainText` rendering correctly instead
of a raw scope dump, per plan deviation #5) — each with its own "Ask me again". "Rules" showed
"No standing rules yet." (confirmed empty after the Task 11(a)/(c) removal).

## Anomalies (documented, not fixed — outside item-6 scope except where noted)

- **`cautionBreaker` fires independently of grants and rules, and non-deterministically.**
  `composeProductionPolicy`'s chain is `volumeBreaker(cautionBreaker(judgePolicy(grantPolicy(base))))`
  — `cautionBreaker` wraps OUTSIDE the entire grant/rule/judge stack, so its own heuristic
  ("a few things seemed unusual") can force an approval card on ANY call, standing grant or not,
  and did so repeatedly throughout this run (nearly every `sendClientMessage` call surfaced a
  "Hold on — checking with you first" card at some point, even well after the loosen grant was
  active). This is why the "3 approvals → fade" and "rule beats grant" beats took more turns
  than item 5's original script: **only approvals that actually surface a consent request count
  toward the fade tracker** — a call the judge auto-approves silently (no card at all — this
  also happened once, for the very first "Delgado" send in the fade sequence, before any grant
  existed) does not. Net effect for item 6 specifically: the "always_ask_before" tighten call
  itself got wrapped in a `cautionBreaker` approval card rather than resolving as the plan's
  hoped-for pure receipt (Task 11 Step 2's expectation) — I approved it and documented the
  actual behavior rather than fighting the harness for a cleaner run. This is a pre-existing
  `cautionBreaker` characteristic (item 4/5's breaker layer), not a defect introduced by this
  item's `compiledRulesPolicy`/`steering-tools.ts` — the rule/grant precedence itself (the
  actual item-6 invariant) verified correctly every time it was cleanly observable.
- **Diary mislabels a permission-changing tool as "a money move."** After confirming
  `stop_asking_about`, the Trust screen's activity feed showed "Loosened a rule — a money move"
  and the diary's "Money moves: 1" counter incremented. `auditLine`'s `tool_execution` case
  (`packages/flowlet-shell/src/components/TrustScreen.tsx`) renders `"— a money move"` whenever
  `row.dangerous` is true, and `row.dangerous` is presumably sourced from the tool's
  `destructiveHint` annotation — which `steering-tools.ts`'s `markCritical` sets on
  `stop_asking_about` for a completely different reason (critical-tier gating, per spec
  principle 7), not because it moves money. This conflates "destructive/critical" with
  "financial" and is a real, if minor, copy bug that is squarely in this item's own tool
  (`stop_asking_about`) — flagged for a follow-up, not fixed here (fixing would mean either a
  new `financial` annotation orthogonal to `destructiveHint`, or a `TrustAuditRow` field beyond
  this item's scope to design unilaterally).
- **`always_ask_before`'s own confirmation copy says "show you the draft and wait for your
  approval before sending"** — accurate paraphrase of the compiled rule's `plainText`
  ("sending a client portal message"), but notably narrower/more specific than the literal
  ask ("before sending client messages"); this is model phrasing variance in the tool's
  `plainText` argument, not a policy bug — the underlying rule's `toolPattern` was the exact
  tool name `sendClientMessage`, confirmed via the Trust screen row and via the rule
  successfully blocking the very next send regardless of the paraphrase.
- One extra, unresolved `FadeProposalCard` ("4th time you've okayed send client message")
  appeared once, immediately after the 3rd-time proposal was already accepted and a grant
  already existed — likely `volumeBreaker`'s own approval counter still incrementing on a call
  that ALSO tripped `cautionBreaker`'s card (i.e. that approval got double-counted toward both
  breakers independently). Declined via **Keep asking**, which is item 5's documented
  decline-suppression behavior and worked as expected (no further duplicate proposals). Not an
  item-6 regression — the same fade/volume-breaker code path as item 5, just triggered twice
  because of the interleaving with `cautionBreaker`.

## Setup notes

- Port 3000 was occupied by a demo-accounting dev server from a DIFFERENT worktree
  (`flowlet/interface`, part of Yousef's live three-app demo playground session) — left
  running, not killed. Port 3005 held a stale demo-accounting server from THIS worktree
  (`eng-193-permissions`, PID 33902 from an earlier partial run) — killed cleanly and
  restarted with `FLOWLET_JUDGE_MODEL=claude-haiku-4-5` set; Next picked port 3002.
