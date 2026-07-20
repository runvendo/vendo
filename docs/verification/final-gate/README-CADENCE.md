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
