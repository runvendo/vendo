# FINAL GATE — Maple half (scoring run)

Held-out scoring run per TASK-MAPLE.md. One attempt per prompt, zero tuning.
Host: demo-bank production (`next start`, port 3000), main @ 090b1779.
Judge bar: docs/eval/GOLDEN.md PASS bar. Timing = submit → app visible.
Repair flag = did structured repair visibly engage (slow first paint / retries)?

## Results

| id | prompt | verdict | timing | class-if-fail | repair? | note |
|----|--------|---------|--------|---------------|---------|------|
| M1 | show me my account balances at a glance | PASS | ~8s | — | no | Host balance card + 4 account cards, money formatted, no errors. Blemish: headline card label "Total balance" shows checking-only ($9,412.20 vs true total $54,907.15) — host component's baked-in label. |
