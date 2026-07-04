# ENG-193 item 2 — browser verification notes (Task 14)

Run: 2026-07-04, `pnpm demo:accounting` (Cadence, localhost:3000, Vendo page),
demo world reset via `POST /api/demo/reset` before the run. All screenshots are
real end-to-end turns against the live agent (claude-sonnet-4-6) with real
Composio Gmail.

## Screenshots

- **01-act-card.png** — act-tier approval card for `sendClientMessage`
  (host tool, client-executed). Question-form title ("Send client message?"),
  "Needs your approval" eyebrow, plain Send it / No buttons, no ceremony
  styling. §3 Moment 3 verified.
- **02-receipt.png** — after approving 01: activity strip
  "✓ Sent client message · +2 more" expanded, with the receipt's `details`
  row open (Id / Body input echo + status 200 / ok true). §3 Moment 2
  verified. Read-only calls (Listed clients / Listed client documents) show
  plain ✓ rows with no details toggle — mutating-only, as designed.
- **03-grant-suppressed.png** — the grant round-trip (§4.3/§4.5), the live
  check unit tests can't prove. Sequence: (1) drove a fresh
  `GMAIL_CREATE_EMAIL_DRAFT` approval card; (2) POSTed
  `/api/flowlet/consent` directly with `decision: "yes"` + a grant draft
  `{tool: GMAIL_CREATE_EMAIL_DRAFT, scope: {kind: "tool"}, duration:
  "standing"}` → 200, grant minted; (3) approved the card (real Gmail draft
  created); (4) repeated the same ask in chat → the second call
  **auto-executed with no approval card** — just the ✓ receipt
  (successful: true) and the done text. The static tool-registry descriptor's
  hash matched the live engine descriptor (the descriptor-hash projection
  fix holds in production).
- **04-ceremony-card.png** — critical ceremony for `setDocumentStatus`
  (reject, wrong file). Amber accent, "MONEY — ALWAYS NEEDS YOU" eyebrow,
  consequence line "This can't be undone.", named confirm button
  ("Confirm set document status"), fields untruncated (full reject reason
  shown). §3 Moment 6 verified. NOTE: this tier comes from the Task 13
  demo-only `x-flowlet-dangerous: true` fixture on the OpenAPI operation
  ("Plan deviations" #3), not a shipped Cadence classification. Declining it
  produced a "⊘ Declined" receipt line (visible at the top of
  05-batch-card.png).
- **05-batch-card.png** — batch card (§3 Moment 4): "chase every client
  missing documents" fanned out to 8 sibling `sendClientMessage`
  approval-requested parts in ONE assistant message, grouped into one card:
  "Send client message 8 times?" with Approve all 8 / Pick which… / No.
- **06-batch-picker.png** — the expanded "Pick which…" checkbox list.
  After checking all 8 and clicking "Approve selected", all 8 portal
  messages executed (each SDK approval answered individually — the final
  summary table listed all 8 clients). §6.5 subset path verified live.
- **07-unverified-tag.png** — "Unverified tool" tag on a Composio card
  (`GOOGLECALENDAR_BATCH_EVENTS`). The tag also appeared on the Gmail card
  in beat 03. Declined; no calendar event was created.

## Bugs found (not fixed here — report only)

1. **REAL BUG — approvals inside continuation turns are never persisted, so
   the consent channel 404s for them.** First attempt at the grant
   round-trip used the pending `sendClientMessage` card from beat 01; the
   consent POST returned
   `404 {"error":"no pending approval for toolCallId …"}`. Root cause,
   confirmed against `ai@6.0.28`'s `handleUIMessageStreamFinish`: when a
   turn is a continuation (the client resubmits with the previous assistant
   message's id — which every host-tool/approval resume and any turn with
   client-executed reads is), `onFinish` returns
   `[...originalMessages.slice(0, -1), state.message]` — the last assistant
   message is REVISED IN PLACE, so the settled list has the SAME length as
   what `onSettled` already stored. The delta-append in both consumers —
   `apps/demo-accounting/src/flowlet/agent.ts` (`onSettled`,
   `messages.slice(existing.length)`) and
   `packages/flowlet-next/src/handler.ts:149` (same pattern) — then appends
   nothing, and the approval-requested part never reaches the ThreadStore.
   Consequence: any approval that lands in the same assistant message as a
   preceding client-executed host-tool call cannot mint a grant through
   `/api/flowlet/consent` (and its consent decisions aren't
   server-validatable). Beat 03 worked because the Gmail approval paused in
   a FRESH assistant message (no prior client reads in the turn) — the
   append-only fast path. Fix direction: `onSettled` consumers must upsert
   the trailing assistant message (replace-last-if-same-id) rather than
   assume strict prefix extension — or the seam needs an upsert affordance.
2. **`ApprovalBatchCard` default selection drops late-streaming siblings.**
   `packages/flowlet-shell/src/components/ApprovalBatchCard.tsx` seeds
   `checked` with a lazy `useState(() => new Set(items.map(i =>
   i.approvalId)))` — captured at first mount, when only the first sibling(s)
   have streamed in. In the live run only 2 of 8 rows were pre-checked
   (06-batch-picker.png). An untouched "Approve selected" would approve 2
   and **decline** the other 6. The checked set should track incoming items.

## Visual/copy anomalies (documented, not fixed)

- Approval-card and receipt field rows render the raw JSON request body as a
  quoted string (e.g. `Body {"body":"Hi Marisol…`) — visible in 01/02/04.
  Truncated with "…" on act cards (by design); on the critical card it is
  untruncated (correct) but still raw JSON.
- Batch picker rows are indistinguishable: `summarize()` only recognizes
  to/recipient/email-ish input keys, and `sendClientMessage`'s input is
  `{id, body}`, so all 8 rows read "Send client message" with no client
  name; the checkbox a11y label falls back to the raw toolCallId. Picking
  "which" is blind for host tools shaped like this.
- Batch picker checkboxes are native/unstyled (default blue accent) —
  off-brand next to the rest of the card chrome (06-batch-picker.png).
- Critical-card eyebrow copy is "MONEY — ALWAYS NEEDS YOU" for a
  document-status change — an artifact of the demo-only fixture forcing the
  money-tier copy onto a non-money tool.
- Composio fallback labels: `GOOGLECALENDAR_BATCH_EVENTS` renders as
  "Googlecalendar Batch Events?" with a generic "Send it" confirm button —
  the verb/label mapping has no entry for it (07-unverified-tag.png).
