# FINAL GATE — Cadence half (scoring run, 2026-07-20)

Held-out scoring run per TASK-CADENCE.md. One attempt per prompt, zero tuning.
Boot: production `next start -p 3200`, PGlite serverExternalPackages (already in
next.config.ts), minted HS256 Supabase JWT cookie (sub = Maya Alvarez seeded
uuid), keys in gitignored .env.local + VENDO_BASE_URL=http://localhost:3200.
Browser: Playwright MCP, 1440x900. Timing = submit (Create click) → app visible.

## Results

| id | prompt | verdict | timing | class-if-fail | note |
|----|--------|---------|--------|---------------|------|
| C1 | a client health dashboard: who's behind on documents | PASS | <=120s (poll bug: render moment missed; app fully rendered at 120s check) | — | stat cards + progress bar + 2 tables w/ populated staff/entity/status selects, formatted dates, pagination, activity feed; no errors. Raw enum text in status cells (missing_docs) noted, not a bar violation |
| C2 | show all clients with their assigned staff and deadlines | PASS | 24.1s | — | 12-client table, staff flattened to name+role columns (no object cells), deadlines formatted, status/staff/entity selects populated, search + sort; no errors |
| C3 | a document collection progress board grouped by status | FAIL | ~25-40s (exact t0 lost: dialog interrupt aborted the timing snippet; single attempt preserved) | filter-wiring (group filter unwired) | two-column board labeled Missing Documents / Complete, but Complete column shows the SAME missing_docs rows (Blue Bottle 3/6, Linear 3/5...) — group tables default to All Status, pill label misrepresents content. Data itself real, formatting fine, no error box |
| C4 | an app to message a client about their missing documents | FAIL | 46.1s | action-wiring (island onClick TypeError: r is not a function) + format (Invalid Date in message history) | client Select works (real {value,label} options, picked Blue Bottle via typeahead), doc chips + prefilled message render, but Send Message crashes in-island (console TypeError, no approval sheet, no effect). Message History timestamps render as Invalid Date |
| C5 | a workload view: how many clients per staff member | PASS | 23.1s | — | stacked bar chart (clients per staff, correct counts 5/3/2/2) + per-staff stat cards w/ missing/complete splits and completion bars, expandable client lists; island-rendered, no errors |
| C6 | show filing deadlines on a timeline for the next 90 days | PASS | 44.2s | — | vertical timeline grouped by month (Jul/Aug/Sep), urgency color legend, day countdowns, doc progress per client, humanized entity types (S-Corp, Sole Prop), all 12 clients, no errors |
| C7 | a client onboarding checklist app | PASS | 19.1s | — | vague ask interpreted as per-client document checklist: stats, filterable checklist table, per-client cards w/ contact+email+docs, deadline risk table; all real host data, no invented onboarding steps, formatted dates, no errors |
