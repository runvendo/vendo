# Held-out gate — Maple half (M1–M15)

Host: demo-bank production boot, port 3000, login yousef@maple.com. One attempt per prompt.
Timing = submit → app visible. "Creating…" indicator was shown on every submit unless noted.

| # | Prompt | Verdict | Timing | Note |
|---|--------|---------|--------|------|
| M1 | show me my account balances at a glance | FAIL | ~15s | App + chart + table render with real data, but Net Worth stat shows raw cents ("$5490715" vs correct $54,907.15) and card title leaks HTML entity ("Checking &amp;amp; Savings"). Classes: raw-cents formatting, entity-escaping. |
