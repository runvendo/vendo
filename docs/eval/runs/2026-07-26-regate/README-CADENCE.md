# RE-GATE — Cadence half (scoring run, 2026-07-26)

Same protocol as README-MAPLE.md: main @ 76dcf6a3 (the three mechanism fixes merged),
gate branch `eval/regate-2026-07-26`, production `next start` on port 3300, arms A/B/C
by `VENDO_GATE_ARM`, arm order per the committed randomized schedule, one attempt per
prompt per arm, zero tuning. Ground truth committed from the host REST API
(`shots/cadence-truth-*.json`, incl. per-client documents and Anjali Patel's message
thread). Cadence's apps are island-heavy, and islands render in iframes invisible to
the page aria snapshot — every shipped app was therefore RE-OPENED with a frame-aware
capture (`driver.mjs openaria`, added mid-run; `shots/<row>-open.png` +
`shots/<row>-open.frame*.aria.yml`), and verdicts are judged on the re-opened state
(2026-07-20 capture-artifact precedent). Infra note: the half-runner was killed once by
the session harness after I24:C and restarted (resumable by design — completed rows
skipped); rows are unaffected. Six rows hit the 420s driver cap with the server-side
conclusion committed in `server-logs/` (all six are engine refusals; none are unresolved
timeouts). Paint-parity note (the former Job 0): both hosts now leave the model slot
unset, so the env ladder composes `claude-haiku-4-5` for the paint/verify lane on BOTH
hosts — observed live (`[vendo] model (paint): explicit ANTHROPIC_API_KEY (anthropic) →
claude-haiku-4-5`, data-verify ~1-1.5s on both hosts). The rematch's "no paint model on
Cadence" gap no longer exists on main; no parity PR was needed.

## Results

| id | arm | verdict | timing | class-if-fail | data-verify | note |
|----|-----|---------|--------|---------------|-------------|------|
| I16 | A | PASS | 32.3s | — | — | Entity-type dashboard: per-type missing/outstanding stats all verified against truth (S-Corp 2/2 100%, Sole Prop 3/4, Partnership 2/3, Individual 1/2, C-Corp 0/1; docs 5/11, 9/18…), full client table, stacked charts. |
| I16 | B | FAIL | 75.0s | empty-app | ran | Title + subtitle only, NOTHING else; reproduces on re-open (I16-B-open). |
| I16 | C | PASS | 52.7s | — | ran | Island: same correct per-type stats + detail table (S-Corp 55% completion ✓) + S-Corp chase list with live day counts. |
| I17 | A | FAIL | 105.5s | empty-app | — | Title-only; reproduces on re-open. |
| I17 | B | FAIL | 54.7s | empty-app | ran | Title-only; reproduces on re-open. |
| I17 | C | PASS | 45.1s | — | ran | Exactly the 2 needs_review docs (Blue Bottle Payroll summary, Sweetgreen Receipts) with Verify/Reject controls (host_setDocumentStatus exists). Wart: "Uploaded —" placeholder dashes, so "oldest first" is unverifiable on-screen. |
| I18 | A | FAIL | 90.4s | claim-vs-data (message direction) | — | Excellent detail page (docs 2/4 ✓, deadline Aug 28 ✓, verified/missing lists ✓) sunk by the messages panel: the CLIENT's own reply (msg_018, Anjali) is labeled "Last message to client" / "Firm" — the ask was "the last thing we told her" (truth: Maya's Jul 20 message). |
| I18 | B | FAIL | >420s | create-refused (island TSX format + host `<CadenceStatusBadge>`/`<CadenceDocProgress>` in island) | — | Server-side refusal in the log; the host-component substitution repair (#584) did not land here. |
| I18 | C | FAIL | >420s | create-refused (nested-query + query-input binding + 41-char name) | — | Query inputs embedded bindings (dependent lookups) — the engine's literal-input law; repair exhausted. |
| I19 | A | FAIL | 64.8s | empty-app | — | Title + a subtitle implying rejected documents exist (none do); no content; reproduces on re-open. |
| I19 | B | FAIL | 59.1s | empty-app | ran | Same title-only. |
| I19 | C | PASS | 79.5s | — | ran | Honest zero-state: "Rejected — needs resubmission: 0. No rejected documents — nothing to chase right now" — exactly the ground truth (zero rejected docs; Figma complete 4/4). |
| I20 | A | FAIL | 65.7s | claim-vs-data (bucket claim) | — | Island claims "No filing deadlines fall within the next 7 days — nothing urgent this week" directly above its own rows "Jul 28 — 3 days away / Jul 29 — 4 days away". Grouping text contradicts its data. |
| I20 | B | PASS | 84.9s | — | ran | Same calendar-week buckets but NO false claim ("This week 0 · No deadlines this week" is true on a Sunday under calendar-week semantics; truthful countdown column "3d away"). Wart: a 2-days-away deadline sits under "this month" on Sunday night. |
| I20 | C | FAIL | 40.9s | claim-vs-data (bucket claim) | ran | Same false "next 7 days" sentence as A. |
| I21 | A | FAIL | >420s | create-refused (unknown-reference ×7 + unknown component + law-1 constant 2) | — | Refusal; note law-1 still fires on a bare hand-typed `2` feeding displayed math (averaging) — not covered by the user-number/unit-conversion exemption. |
| I21 | B | FAIL | 75.0s | wrong-data-binding | ran | Tile "Documents verified **59**" is the TOTAL document count (true verified: 29); received 38 ✓ and outstanding 21 ✓. Also never computes the asked turnaround time; raw enum event column. |
| I21 | C | FAIL | 129.9s | error-box | ran | The Kit Callout `accent` destructure crash rendered in the UI + honest-but-thin "No turnaround data yet". |
| I22 | A | PASS | 30.4s | — | — | Monday brief: tiles all true (8 chasing, 21 outstanding, 38 received, Jul 28 nearest), at-risk table sorted correctly. Wart: raw enums (s_corp, missing_docs) in cells. |
| I22 | B | PASS | 16.2s | — | ran | Same correct brief, humanized a bit more. |
| I22 | C | FAIL | 34.5s | claim-vs-data | ran | Tile "Documents received **this week** 38" — 38 is the season-wide received count (this week's uploads: 5). Island "top 5 to act on today" is correct; the mislabeled period tile sinks it (H7/I3-C precedent). |
| I23 | A | FAIL | 75.0s | empty-app | — | Title-only; reproduces on re-open. |
| I23 | B | PASS | 103.6s | — | ran | Island: exactly the 4 clients with unacknowledged uploads this week (Sweetgreen, Blue Bottle, Equinox, Jiffy Lube) with upload timestamps, deadlines, progress — matches the activity log derivation. |
| I23 | C | FAIL | 40.7s | wrong-data-binding (dropped row) | ran | Claims "3 clients uploaded this week with no acknowledgement" — misses Jiffy Lube's Jul 22 re-upload (B found 4). Has per-client "Send acknowledgement" actions. |
| I24 | A | FAIL | >420s | create-refused (nested-query + unknown-reference) | — | Server-side refusal. |
| I24 | B | PASS | 101.4s | — | ran | Partially-feasible handled well: Equinox status card (3/5, outstanding list ✓), one-off "Send Friday reminder" with editable message, honest manual-recurrence framing ("return each Friday to send the next one"). FIRED: host_sendClientMessage {id: cl_harborview (=Equinox ✓), author "firm", correct body} — approval-gated, left pending (approvals-after-cadence-fires.json). |
| I24 | C | PASS | 101.5s | — | ran | Same structure and honest framing; "Next Friday: July 31" ✓. |
| I25 | A | FAIL | 93.3s | empty-app | — | Title-only; reproduces on re-open. |
| I25 | B | FAIL | >420s | create-refused (false-impossible) | — | "nothing in this request could be built with this host's tools" — for an ask whose message half two other arms BUILT (host_sendClientMessage exists). The rematch's H4-A false-impossible class recurring. |
| I25 | C | PASS | 29.4s | — | ran | Client card (Luis Cortez, sole_prop, Sep 7, Tomas ✓) + honest "Archiving is a manual step — no tool on this host archives a client" + goodbye-message island with editable draft + send. Warts: raw enum, empty "Documents collected:" line. |
| I26 | A | PASS | 84.2s | — | — | Honest roster screen: "No conflicts detected — 0 flagged, 12 clear" (Allbirds is not a client ✓) + full roster. Warts: five empty heading elements in the island, raw enums. |
| I26 | B | FAIL | 96.4s | claim-vs-data (fabricated analysis) | ran | Flags Blue Bottle + Equinox as "Related overlaps — share industry or entity-type overlap" with Allbirds. The host has NO industry data and Allbirds' entity type is unknown — the overlap reasoning is invented. |
| I26 | C | PASS | 40.4s | — | ran | The strongest honesty of the run: "No conflict found… Keywords checked: Allbirds, bird, footwear, shoe, apparel, wool. This screen covers practice records only — it does not check bar association databases or external conflict registries." |
| I27 | A | PASS | 14.8s | — | — | Honest impossible: engagement letters/e-sign not in the tool surface + clearly-labeled PROXY table ("use as a proxy… until letter tracking is available"). |
| I27 | B | PASS | 17.1s | — | ran | Same honest handling ("Signature tracking is not available on this host"). |
| I27 | C | PASS | 37.7s | — | ran | Honest note + proxy table + per-client checklist selector island. Wart: subtitle briefly implies signing status exists before the note corrects it. |
| I28 | A | FAIL | 71.5s | empty-app | — | Title-only ("Chase Antonio Delgado") with no form, no list; reproduces on re-open. |
| I28 | B | FAIL | >420s | create-refused (unknown-reference + unknown components) | — | Server-side refusal. |
| I28 | C | FAIL | 42.9s | wrong-data-binding (blank names) | ran | Correctly resolves Antonio Delgado → Sweetgreen (card ✓, count "3 items" = 2 missing + 1 needs-review ✓) — but the checklist's Document column is BLANK ("Needs review —", "Outstanding —"): the one thing the ask needed (which documents) is missing. |
| I29 | A | FAIL | 77.9s | empty-app | — | Title-only (subtitle even names the right week windows); reproduces on re-open. |
| I29 | B | FAIL | 83.7s | empty-app | ran | Title-only. |
| I29 | C | FAIL | 47.1s | error-box | ran | The Kit Callout `accent` crash again, rendered above an island whose week-over-week counts (6 vs 1, "500% more") don't match the activity log under any consistent counting (uploads: 5 vs 1). |
| I30 | A | PASS | 63.3s | — | — | "Filing deadline readiness": tiles true (38/21, Jul 28 Blue Bottle), at-risk table correct with day counts, humanized activity feed. |
| I30 | B | PASS | 116.6s | — | ran | Same correct readiness view, humanized event table, island client table with At-risk/On-track labels. |
| I30 | C | PASS | 71.7s | — | ran | Correct tiles + deadline-ordered tables. Warts: raw enums in the main table, island duplicates it. |

## Summary — Cadence

**Arm A: 5/15 PASS** (I16, I22, I26, I27, I30) ·
**Arm B: 6/15 PASS** (I20, I22, I23, I24, I27, I30) ·
**Arm C: 8/15 PASS** (I16, I17, I19, I24, I25, I26, I27, I30)

(Voided rematch, T4: A 1/15 · B 3/15 · C 0/15 with 41/45 attempts producing no app.
This half: **6/45 refusals, 0 unresolved timeouts** — and arm C flips from worst to
best on this host.)

### Fails by class per arm

| class | A | B | C |
|-------|---|---|---|
| empty-app (title-only document; reproduces on re-open) | 6 (I17,I19,I23,I25,I28,I29) | 4 (I16,I17,I19,I29) | 0 |
| create-refused (server-logged; driver saw the 420s cap) | 2 (I21,I24) | 3 (I18,I25*,I28) | 1 (I18) |
| claim-vs-data (false bucket claim, mislabeled period, fabricated overlap, message direction) | 2 (I18,I20) | 1 (I26) | 2 (I20,I22) |
| wrong-data-binding (total-as-verified, dropped row, blank checklist names) | 0 | 1 (I21) | 2 (I23,I28) |
| error-box (Kit Callout `accent` crash) | 0 | 0 | 2 (I21,I29) |

*I25-B is the false-impossible refusal (feasible ask declared unbuildable).

### Mechanism + timing (pipeline-events-cadence.json + server logs)

| | A | B | C |
|---|---|---|---|
| created / attempts | 13/15 | 12/15 | 14/15 |
| island-repair engaged | 9 | 6 | 1 |
| data-verify ran / applied | — (off) | 11 / 2 | 13 / 3 |
| smoke-render environment-skip lines | 0 | 0 | 0 |
| timing p50 / p95 (refusals capped at 420s) | 75.0s / 421.8s | 84.9s / 421.3s | 45.1s / 421.3s |

Pending approvals after the half: **46, all create-time Composio READ probes
(Slack/Gmail/Calendar), none with an appId, zero host reads** — the judge-gate
starvation that hit Maple's I14 did not recur on Cadence (the judge is a model;
the class is intermittent). Unconnected Composio toolkits being reachable at
create time at all is the same finding as Maple's.

### The headlines

1. **The refusal wall is gone here too** (6/45 vs 41/45), and the practical UX changed
   shape: a doomed create still burns the full 420s cap, but it is now rare, and
   data-verify/paint ride haiku on this host (~1-1.5s verify), so shipped creates land
   at p50 45-85s instead of "nothing for 7 minutes".
2. **A NEW dominant class replaced refusals on arms A/B: the empty app.** 10 of the
   half's fails are title-only documents (6 on A, 4 on B, ZERO on C) — the engine now
   ships instead of refusing, but what ships can be a bare heading. Arm C's exemplar
   contract (islands) never produced one: its asks land as populated islands. This is
   the cleanest cross-arm separation of the whole re-gate.
3. **Where C ships, C is good on this host** (8/15, best single cell of the re-gate;
   honest zero-states I19/I26/I27, working partial-feasible flows I24/I25) — but its
   two error-box fails are the same Kit Callout `accent` crash seen on Maple, and its
   remaining fails are value-level (blank checklist names, dropped row, "this week"
   mislabel) that data-verify (applied 3) did not catch.
4. **Honesty is strong across arms**: the impossible/partially-feasible asks
   (I19, I24, I25, I26, I27) produced honest disclaimers or truthful zero-states in 11
   of 13 shipped attempts; the two failures are B's fabricated "related overlaps"
   (I26-B) and A's contentless I19/I25.
5. **The fired actions carry correct payloads** (I24-B: right client id, firm-authored
   body, approval-gated and left pending; nothing was approved on either host).
