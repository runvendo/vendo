# ENG-193 item 2 — browser verification notes (Task 14)

Two live passes against `pnpm demo:accounting` (Cadence, localhost:3000, Vendo
page), demo world reset via `POST /api/demo/reset` before each run. All
screenshots are real end-to-end turns with the live agent (claude-sonnet-4-6)
and real Composio Gmail.

- **Pass 1 (2026-07-04):** found two real bugs + presentation gaps (see
  "Bugs found", all since fixed).
- **Pass 2 (2026-07-04, after the fixes):** re-shot 02/04/05/06 and re-ran the
  grant round-trip on the previously-failing path. 01/03/07 are pass-1 shots
  (their behavior was already correct).

## Screenshots

- **01-act-card.png** — act-tier approval card for `sendClientMessage`
  (host tool, client-executed). Question-form title ("Send client message?"),
  "Needs your approval" eyebrow, plain Send it / No buttons, no ceremony
  styling. §3 Moment 3 verified.
- **02-receipt.png** *(pass 2)* — after approving: activity strip
  "✓ Sent client message · +2 more" expanded with the receipt's `details` row
  open. The Body input now renders as readable `Key: value` lines
  ("Body: Hi Marisol, …") instead of raw JSON; act-tier truncation still
  applies. §3 Moment 2 verified. Read-only calls show plain ✓ rows with no
  details toggle — mutating-only, as designed.
- **03-grant-suppressed.png** — the grant round-trip (§4.3/§4.5): consent
  POST with `decision: "yes"` + a standing tool-scope grant draft → 200 →
  approve card → repeat the same ask → **auto-executed with no card**, just
  the ✓ receipt. Shot on `GMAIL_CREATE_EMAIL_DRAFT` (pass 1). In pass 2 the
  same round-trip was re-proven on the CONTINUATION path that used to 404
  (see bug #1): grant POST for a `sendClientMessage` card that followed
  client-executed reads → 200, and a follow-up "message Chen too" turn
  executed cardless off that grant.
- **04-ceremony-card.png** *(pass 2)* — critical ceremony for
  `setDocumentStatus` (reject, wrong file). Amber accent, tier-generic
  "ALWAYS NEEDS YOU" eyebrow (was money-specific copy), consequence line
  "This can't be undone.", named confirm button, fields untruncated and the
  Body object rendered as compact "Action: reject / Reason: …" lines.
  §3 Moment 6 verified. NOTE: the tier comes from the Task 13 demo-only
  `x-flowlet-dangerous: true` fixture ("Plan deviations" #3), not a shipped
  Cadence classification.
- **05-batch-card.png** *(pass 2)* — batch card (§3 Moment 4): 8 sibling
  `sendClientMessage` approval-requested parts in ONE assistant message,
  grouped: "Send client message 8 times?" with Approve all 8 / Pick which… /
  No.
- **06-batch-picker.png** *(pass 2)* — the expanded "Pick which…" list after
  the fixes: **all 8 rows pre-checked** (late-streaming siblings included),
  each row identifiable ("cl_rivera — Hi Marisol, this is a reminder…" =
  identity + snippet), checkboxes styled in the brand accent (no native
  blue). Approve-selected then executed all 8 (per-id SDK answers; final
  summary listed all 8 clients). §6.5 verified.
- **07-unverified-tag.png** — "Unverified tool" tag on a Composio card
  (`GOOGLECALENDAR_BATCH_EVENTS`). Declined; no calendar event was created.

## Bugs found in pass 1 — both FIXED (commit `fd4c9b03`) and re-verified live

1. **Approvals inside continuation turns were never persisted → consent
   404.** Root cause (confirmed against `ai@6.0.28`
   `handleUIMessageStreamFinish`): a continuation turn (any host-tool or
   approval resume) REVISES the trailing assistant message in place —
   `onFinish` returns `[...originalMessages.slice(0,-1), state.message]`,
   the SAME length as what onSettled already stored — so the append-only
   prefix delta in `apps/demo-accounting/src/flowlet/agent.ts` and
   `packages/flowlet-next/src/handler.ts` persisted nothing, and the
   approval-requested part the consent endpoint reads never hit the store.
   **Fix:** optional `ThreadStore.replaceMessages` seam member
   (`@flowlet/core`, additive like `Store.grants`), implemented in
   `InMemoryThreadStore`, used by both onSettled consumers (append-only
   delta kept as fallback for stores without it). Regression tests drive the
   full turn-1/continuation/consent sequence in both packages. Live
   re-verified in pass 2: the grant POST on a continuation-turn card
   returned 200 and suppressed the next ask.
2. **`ApprovalBatchCard` default selection dropped late-streaming
   siblings.** The checked set was seeded once at mount (only 2 of 8 rows
   pre-checked live); an untouched "Approve selected" would have approved 2
   and DECLINED 6. **Fix:** until the user touches a checkbox, every current
   item counts as checked; the explicit set takes over on first interaction.
   Regression test streams 6 extra siblings after mount. Live re-verified:
   all 8 pre-checked, approve-selected sent all 8.

## Presentation gaps from pass 1 — FIXED (polish commit) and re-verified

- Raw JSON in card/receipt field rows → object/array values now render as
  compact depth-1 `Key: value` lines (`field-rows.ts`), truncation per line,
  critical cards still untruncated (02/04).
- Batch picker rows were indistinguishable and a11y-labeled with raw
  toolCallIds → rows now summarize identity + body snippet; a11y labels are
  human ("cl_rivera — Hi Marisol…", or positional "Send email 1 of 2"),
  never a toolCallId (06).
- Native blue checkboxes → `fl-` styled, brand accent + focus ring (06).
- "Money — always needs you" eyebrow on a non-money critical tool →
  tier-generic "Always needs you" (04).

## Remaining notes (not bugs)

- Composio fallback labels: `GOOGLECALENDAR_BATCH_EVENTS` renders as
  "Googlecalendar Batch Events?" with a generic "Send it" confirm button —
  the verb/label map has no entry for it (07).
- One transient turn-level failure in pass 2: the known tool-input JSON
  breakage (Anthropic 400 "tool_use.input: Input should be an object",
  documented separately as a runtime-upstream repair candidate). Retry
  succeeded; unrelated to this item's changes.
