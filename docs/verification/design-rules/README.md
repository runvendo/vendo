# Live gate — design rules config key + per-generation file reads (PR #452)

2026-07-20, Maple demo (`pnpm --filter demo-bank dev`), real Anthropic models
(sonnet full lane), real browser (Playwright), seeded demo user.

Procedure and evidence:

1. Wrote `apps/demo-bank/.vendo/design-rules.md` rule set A — "banner reading
   exactly STYLE CHECK ALPHA" + "all-caps section titles" — then started the
   dev server and asked Ask Maple for a spending dashboard.
   `alpha-app-page.png`: the generated app opens with the STYLE CHECK ALPHA
   banner and every section title is all-caps (SPENDING BY CATEGORY, BUDGET
   TRACKER, MONTHLY CASH FLOW).
2. WITHOUT restarting the server, rewrote the file to rule set B — "STYLE
   CHECK BRAVO" + "sentence case titles (never all-caps)" — and created a
   second app from the Apps page.
   `bravo-app-page.png`: the new app opens with the STYLE CHECK BRAVO banner
   and sentence-case section titles (Savings goals, Goal progress, Spending
   by category).

Both rule sets honored; the flip proves the per-generation file read (the
old compose-time read would have kept ALPHA until a restart). The test
`design-rules.md` was removed from the demo afterward — it was gate
scaffolding, not demo content.
