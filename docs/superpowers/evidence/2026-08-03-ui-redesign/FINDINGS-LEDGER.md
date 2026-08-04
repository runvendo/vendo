# Checker findings → disposition ledger (agentic UI redesign wave)

Two independent adversarial passes ran on this wave. Their findings lived only
in the conducting session's transcript, which the second pass correctly called
an auditability gap ("the first-pass findings list is not in the repo, so six
IDs cannot be verified either way"). This file closes that gap. Rulings cited
are in the conductor's ruling log (18 → 24 items; see the wave plan).

## Pass 1 — 40 findings

| ID | Finding (one line) | Disposition |
|---|---|---|
| C1 | Policy banner rendered on every end-user surface except cards | FIXED (default flipped to opt-in; 8 redundant props removed) · verified CLOSED in pass 2 |
| C2 | Activity panel printed the guard's raw `tool + canonicalJson` | FIXED, then pass 2 proved PARTIAL (id VALUES still verbatim) → re-fix in postcheck2-product |
| C3 | §15 unenforced; retry affordances on end-user surfaces; one added by the wave | CLOSED BY RULING 16 + 18 (Yousef's decision): thread Retry removed; non-conversational surfaces keep line + Try again; ruling 22 records the non-retryable exception |
| C4 | Turn-error gate admitted developer sentences; two paths disagreed | FIXED (one shared helper, code token stripped, no raw fallthrough), pass 2 proved content PARTIAL → re-fix (map by code) |
| C5 | Money card could name the wrong amount, then fold the real rows | FIXED for top-level, pass 2 proved nested PARTIAL → re-fix (fold only when every money value is represented) |
| H6 | Card and queue row implemented different plain-words ladders | FIXED (one ladder), pass 2 proved PARTIAL (keyed off two different fields) → re-fix |
| H7 | The runtime consumer-voice gate ADMITTED raw JSON/exceptions/model instructions | CLOSED BY RULING 14 — this finding was the argument for reversing ruling 11; the gate is now a test oracle only, descriptor text is never user copy |
| H8 | The same gate silently DELETED legitimate host copy | CLOSED BY RULING 14 (same reversal) |
| H9 | V4 auto-stage re-fired against Back-to-chat (G1 violation) | FIXED (ledger in the reducer) · verified CLOSED in pass 2 · ruling 23 rescopes the ledger to the turn |
| H10 | Closing ··· left the rail with zero tab stops; dangling panel label | FIXED · verified CLOSED |
| H11 | Focusable live app content inside `aria-hidden` tiles | FIXED with `inert` · pass 2 found it silently absent on React 18 (a declared peer) → re-fix |
| H12 | Mobile takeover covered the host without inerting it; second `<main>` | FIXED · pass 2 found the shared module's stacking/release contract broken → re-fix |
| H13 | Unvalidated grant-set wire shape (": Send money", decide([undefined])) | FIXED · verified CLOSED |
| H14 | Grant rows said "Reads" for a send tool; destructive flattened to "Changes" | FIXED, then REGRESSED (verb matched anywhere in the name → a getter says "This moves money") → re-fix, worst item in the wave |
| H15 | Three concurrent /approvals pollers (36 req/min/user) | FIXED (shared feed; measured 39→13 per 60s) · CLOSED in code, pass 2 proved UNGATED → gate it |
| H16 | Apps door mounted every app live, unbounded | FIXED (viewport gate) · verified CLOSED, all four attacks clean |
| H17 | Focus dropped on every center navigation and card decision | FIXED · pass 2 found two paths still land on `<body>` → re-fix |
| H18 | Arrow-keying the rail ACTIVATED rows (destroyed the open conversation) | FIXED (APG manual activation) · verified CLOSED |
| M19 | §8's one-animation law false while prose streams | FIXED (CSS suppression) · pass 2 proved the TEST is blind → fixture widened in postcheck2-gate |
| M20 | A failed build narrated twice | FIXED |
| M21 | Failed staged build left the panel expanded over an empty stage | FIXED |
| M22 | A denied call treated as live for the rest of the turn | FIXED |
| M23 | Pill narrated parked/denied steps; ring stalled | FIXED |
| M24 | Beat result read "6 data" / "1 row" | FIXED |
| M25 | Toast headline was the raw first markdown line | FIXED |
| M26 | Settled duration understated after a panel reopen | FIXED |
| M27 | Center had no background-run narration; conversation switch orphaned a turn | FIXED (pulse selector, key, shared hook) |
| M28 | Staged stage shows only the first skeleton snapshot | ASSIGNED postcheck2-product (state whether deliberate) — was undispositioned |
| M29 | Wave-added motion ignored OS reduced-motion | FIXED |
| M30 | Three surviving `aria-label`-on-a-div | FIXED (all three) |
| M31 | A new ask announced to nobody | FIXED (persistent status regions, both surfaces) |
| M32 | Raw tool slugs reach assistive tech via `title`/`aria-live` | ASSIGNED postcheck2-product — was undispositioned |
| M33 | S1 indicators failed WCAG 1.4.11 (1.11:1 vs 3:1) | FIXED (`--vendo-indicator`) · AMENDS checklist 7 per ruling 20 |
| M34 | Mobile history sheet had no keyboard contract | FIXED |
| M35 | Completion toast timed, interactive, unpauseable (WCAG 2.2.1) | ASSIGNED postcheck2-product — was undispositioned |
| M36 | Ungated wire/exception strings on generated-app and voice surfaces | FIXED (dev-gated; ContainedNotice gained a dev-only detail seam) |
| L37 | Raw JSON/booleans one hover away in `title` on consent cards | FIXED (title dropped; law test widened to read `title`) |
| L38 | Morph toast title computed without the descriptor | FIXED |
| L39 | Dangling `aria-controls` on the rail's tabs | FIXED |
| L40 | Minor: stale `Date.now()` memo; region renamed after fetch; raw `outcome.status`; a vacuous assertion | FIXED (rail/apps-page halves) |

## Pass 2 — new findings

CR-1 H14 regression · CR-2 activity id values · CR-3 error content passthrough ·
CR-4 the six untraced IDs (answered above, ruling 19) · H-1 card/row keyed off
two fields · H-2 inert stacking/release · H-3 two focus paths · H-4 `inert` on
React 18 · H-5/finding-10 H15 ungated · H-6 `unchanged()` compares ids only ·
H-7 nested money folds · gate has no aggregation (ruling 24) · ENOBUFS armed ·
2 of 11 smoke tests don't discriminate · checklist 3 and 7 mis-worded (ruling 20).
All are assigned to `redesign/postcheck2-product` or `redesign/postcheck2-gate`.

## Standing law from this wave

Ruling 21 (fixture law, third strike): a fix is not done until a test FAILS with
the fix reverted, and the reverting proof is recorded. Fixture blindness hid a
defect in three consecutive passes — the fix was right every time; the fixture
could not express the defect class.

## Landing pass — three dispositions changed after both checker passes

These are recorded here because they REVERSE or restructure a disposition
above. Reading the table alone would otherwise mislead.

| ID | What changed at landing | Why |
|---|---|---|
| H14 / CR-1 | **Mechanism DELETED, not re-fixed.** The table says H14 was fixed by taking the row's word from the ask's own verb, and CR-1 narrowed that to the leading verb token. Both are gone: `VERB_CLASSES`, the six `VERBS` word sets, `verbToken`, `verbClassOf`, `understates` and `verbWord` are deleted, and the class sentence and grant-row word now read the RISK GRADE and nothing else. | Yousef's risk-grading ruling (D1, PR #747) is categorical — no code path may conclude anything from a tool's NAME. A word list misses silently and its existence reads as coverage. H14's underlying defect (a `read`-graded send tool renders "Reads") is knowingly ACCEPTED: the fix belongs upstream, in the judge or `overrides.json`. Pinned as a test, with the tradeoff named. |
| H18 | **Guarantee kept, mechanism replaced.** The table says H18 was fixed with APG manual activation. Manual activation is gone; the tablist activates on arrow again. | Manual activation was only ever needed because an ACT ("New chat") sat inside the tablist. It is a plain button outside the list now, so the arrows cannot reach it and H18 holds structurally. The same change fixed a second defect: the act was exposed as `role="tab"`, so `getByRole("button", …)` — how every other surface exposes this gesture — matched nothing, which is what broke ENG-222's browser proof. |
| — | **`ungraded` is carried, not approximated.** The wave mapped an absent wire risk to `write` + `critical: true` in the client. | #747 made `ungraded` a first-class `RiskLabel`. The client approximation is deleted; the wire carries the state as itself and each card derives its own ceremony from the grade. Our "ungraded never folds" ruling now composes with main's "the guard asks on ungraded" instead of duplicating it. |

### Reported, NOT changed — open for Yousef

`core/grant-sets.ts`'s `mechanicalRisk` is a NAME-based vote (main's, from
#747's merge of the rebuild cutover), and it DOES reach consumer card copy on
one path: `automations/adoption.ts:54` sets each adoption need's risk to
`resolvedRisk(descriptor)`, which the AdoptionCard renders through
`grantRowWord`. The approval card is unaffected — it reads the assigned
`descriptor.risk`. Behaviour left exactly as main has it, per instruction.
