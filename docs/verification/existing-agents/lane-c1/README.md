# Existing-agents Lane C1 — browser evidence (`examples/ai-sdk-agent`)

The example's full demo script driven live in a real browser (Playwright,
Chromium) against `pnpm --filter @vendoai-examples/ai-sdk-agent dev` with a
real `ANTHROPIC_API_KEY` (both models live: the quickstart loop's
`claude-sonnet-4-6` in `/api/chat` and Vendo's generation seam). Captured
2026-07-20. One thread, all three value props:

- `lane-c1-01-full-thread.png` — the whole conversation: guarded weather
  lookup (turn 1, plain data — the model narrates 64°F/sunny for Paris),
  the inline generated dashboard (turn 2), and the approval card resolved to
  "Approved — ran" (turn 3).
- `lane-c1-02-app-building-inline.png` — turn 2 mid-build: the model called
  `vendo_create_app`, got the `vendo/app-ref@1` envelope back fast, and
  `<VendoAppEmbed>` shows the build-beat bar + skeleton while the build
  streams server-side (the embed polls `open()` until the app lands).
- `lane-c1-03-app-built-inline.png` / `lane-c1-03b-app-embed.png` — the
  built "Weather Comparison Dashboard" served over the wire and rendered
  inline in the quickstart's own chat markup.
- `lane-c1-04-approval-card.png` — turn 3: `vendo_host_send_trip_report`
  parked (risk `write` under the `cautious` policy) and returned a
  `vendo/approval-ref@1` envelope; `<VendoApprovalEmbed>` renders the consent
  card with the REAL tool inputs (to/subject/body), the `write` badge,
  "Runs as you · asked here in chat", and the Remember disclosure.
- `lane-c1-05-approve-resume-executed.png` — after clicking Approve: the wire
  executed the parked call and the card resolved in place to "Approved — ran"
  with the executed result (`{"to":"boss@example.com",…,"delivered":true}`).

Notes:

- Turn 2's model behavior was a bonus proof: it first fanned out three
  parallel `vendo_host_get_weather` calls (all guarded, all plain data),
  then called `vendo_create_app` with the collected numbers.
- The `GET /api/vendo/apps/:id/open` 404s in the console during the build
  are the embed's documented poll-until-served behavior, not failures.

The hermetic counterpart (no keys) is the example's own fixture e2e:
`examples/ai-sdk-agent/e2e/byo-agent.e2e.test.ts` (`pnpm --filter
@vendoai-examples/ai-sdk-agent test`).
