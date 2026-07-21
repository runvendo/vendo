# Existing-agents Wave 4 — final integrated-tree browser evidence

Fresh end-to-end pass of both examples' demo scripts on the FINAL merged
branch (post code-review fix `ffb1511f`), live model turns with real keys,
captured 2026-07-20. This re-verifies the approval read path after the
mid-resume review fix.

## examples/ai-sdk-agent (AI SDK quickstart + Vendo)

- `wave4-c1-app-built.png` — "Make me a dashboard comparing the weather in
  Lisbon, Tokyo, and Toronto": the agent fanned out three parallel guarded
  weather calls, `vendo_create_app` returned fast, the build streamed, and
  the generated dashboard renders live inside `VendoAppEmbed` in the
  quickstart's own chat markup.
- `wave4-c1-approval-card.png` — "send the trip report": `vendo_send_trip_report`
  parked; `VendoApprovalEmbed` renders the consent card with the real tool
  inputs while the model's prose correctly says it is waiting (loop never
  blocked).
- `wave4-c1-approved-executed.png` — after Approve: the card resolves in
  place to "Approved — ran" with the executed result
  (`{"to":"client@example.com","delivered":true}`).

## examples/mastra-agent (create-mastra starter + Vendo)

- `wave4-c2-app-built.png` — same dashboard ask through the Mastra agent:
  `vendo_create_app` via the `@vendoai/vendo/mastra` shim, generated app
  rendering inline with live guarded weather data.
- `wave4-c2-approval-card.png` — "Email the report to ops@example.com": the
  agent re-fetched fresh data through three guarded `vendo_get_weather`
  calls, then `vendo_send_trip_report` parked; consent card shows the full
  report payload.
- `wave4-c2-approved-executed.png` — Approve resolves in place to
  "Approved — ran" with `{"sent":true,"recipient":"ops@example.com"}`.

Console noise during the build window is the known `open` 404-poll
(documented follow-up); no other errors.
