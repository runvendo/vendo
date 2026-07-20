# Lane C2 — examples/mastra-agent browser evidence

Live demo-script run (2026-07-20) against `examples/mastra-agent` on
`next dev` (port 3100) with real keys from the canonical env file:
OPENAI_API_KEY drives the starter agent (`openai/gpt-4.1-mini`, see README for
the gpt-5-mini upstream-bug note) and Vendo's env ladder picks up
ANTHROPIC_API_KEY for app generation. Browser: Playwright (Chromium).

1. `lane-c2-01-weather-tool.png` — "What's the weather in Paris?": the
   starter's own `weatherTool` answers, untouched by the Vendo diff.
2. `lane-c2-02-app-embed-dashboard.png` — "Make me a dashboard comparing
   weather in Paris, Tokyo and NYC": the agent calls three `weatherTool`
   lookups then `vendo_create_app`; the generated dashboard builds and renders
   INLINE via `<VendoToolResult>` → `<VendoAppEmbed>`, and its queries resolve
   live data through the guarded `get_weather` host action over the wire
   (Paris 20.7°C / 41%, Tokyo 29.3°C / 73%). Unbound cells render "—"
   (generation binding variance, not a seam failure).
3. `lane-c2-03-approval-card.png` — "Email the report to ops@example.com":
   `vendo_send_trip_report` parks on the cautious policy and
   `<VendoApprovalEmbed>` renders the approve/deny card inline with the real
   tool inputs (the full three-city report text).
4. `lane-c2-04-approved-executed.png` — after Approve: the embed resolves in
   place to "Approved — ran" with the executed result
   `{"sent":true,"recipient":"ops@example.com"}` — the parked call executed
   server-side through the wire's approve-resume machinery.

Known cosmetic noise during the build window: `<VendoAppEmbed>` polls
`GET /apps/:id/open` until the streamed build persists, so the console logs
404s for ~30s before the app lands (by-design self-scheduling poll).
