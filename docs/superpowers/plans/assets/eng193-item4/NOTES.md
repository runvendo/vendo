# ENG-193 item 4 — Task 13 browser verification notes

Verified live against `pnpm demo:accounting` (run on port 3001; another
worktree's Cadence instance held 3000), driven with Playwright MCP on
2026-07-04. World reset (Cmd+Shift+.) before each pass.

## Runbook variant

Plan Task 13 option (a): the morning-chase automation built with NO grants —
verbatim ask: *"every morning, email any clients missing docs. Do NOT
pre-authorize or grant the email send — leave grantedTools empty…"*. The agent
compiled the usual deterministic spec (get_deadlines → for_each missing_docs →
GMAIL_SEND_EMAIL) with `grantedTools: []` ("Send email — asks you each time"
on the AutomationCard). Force-fired with "run it now live, actually send them".

## Beats verified

1. **Run SUCCEEDS with parked actions** — the live force-fire completed
   (activity ✓ "Test-fired automation", no error banner); every for_each
   iteration's ungranted `GMAIL_SEND_EMAIL` parked instead of failing the run.
   `run-succeeded-with-parks.png`.
2. **WaitingList inbox** — "Waiting on you (8)", one row per parked email
   (question-form title, input preview, relative time, Approve/Decline).
   `waiting-list-inbox.png`.
3. **Approve executes** — approving the Rivera row POSTed
   `/api/flowlet/parked-actions/resolve` → `{"ok":true,"executed":true}`
   (a REAL Gmail send to yousef+rivera@vendo.run via Composio); the row left
   the list (count 8 → 7). `waiting-list-approved.png`.
4. **Decline stays declined** — declining the Chen row returned
   `{"ok":true,"executed":false}` (request body `{"actionId":"parked-2",
   "decision":"no"}`), no send occurred, the row left the unresolved list and
   a later approve on the same id errors "already resolved" (invariant suite
   covers the latter). `waiting-list-declined.png`.
5. **Critical ceremony rows** — a second automation routes the demo's
   critical-annotated `set_document_status` (destructiveHint, mirroring item
   2's `x-flowlet-dangerous` OpenAPI fixture) through a for_each over
   documents in review. All 9 iterations parked `reason: "critical"`,
   `tier: "critical"` — even though the run was force-fired live — and render
   the ceremony register (amber row, named "Confirm set document status"
   button). Zero `document_verified` activity entries after the run: the
   critical tool never executed unattended. `waiting-list-ceremony.png`.
6. **sendConsent live check (carried-over wiring gap)** — chat-card approvals
   (AutomationCard approve, run-now "Send it") each POSTed
   `/api/flowlet/consent` → 200 (`handleConsent` appends the `consent` audit
   event before returning ok), confirming the newly wired seam in
   `FlowletRoot.tsx` reaches the audit trail.

## Demo-only fixtures added for beat 5 (flagged, same precedent as item 2)

- `apps/demo-accounting/src/flowlet/automations.ts`: two new registered
  automation tools — `get_documents_for_review` (read-only) and
  `set_document_status` (destructiveHint: true wrapping the server's
  `transitionDocument`). Cadence had NO critical tool registered in the
  automation world (only get_deadlines + the two Composio sends), so the
  ceremony beat was impossible without this — exactly the case plan Task 13
  step 7 anticipated. Demo-scoped classification, not a product claim.
- `apps/demo-accounting/src/flowlet/policy.ts`: `get_documents_for_review`
  added to ALWAYS_ALLOW (in-process read, same class as get_deadlines) —
  without it the lowercase name matches no READ_VERBS segment, the direct
  fetch step fails safe to "approve", and the run checkpoint-pauses before
  the loop ever parks.

## Observations / bugs found (not fixed — outside scope)

- **Model copy overstates**: after the first parked run the agent's summary
  said "8 chase emails sent" when all 8 were parked awaiting approval (a
  later pass phrased it correctly as "approval cards queued"). Copy-level
  model behavior, not a runtime bug — the §4.6 ruling's "run summary says
  what's waiting" instruction may deserve a stronger prompt nudge.
- **Composer dock intercepts clicks on the last thread card**: when the
  thread is scrolled to its bottom limit, the final message's action buttons
  (e.g. "Approve automation") can sit under `.fl-dock-anchor`/`.fl-composer`,
  which intercepts pointer events — the thread's bottom padding does not
  fully account for the dock, most visibly with the WaitingList strip
  mounted. Worked around by enlarging the viewport. Shell layout issue worth
  a look in the UI review.
- Screenshots of beats 1–4 predate a dev-server restart mid-pass (external
  SIGTERM); the world was rebuilt and beats re-verified after it — beat 4's
  evidence (resolve response + list state) is from the second pass.
