# HELD-OUT CORPUS — 30 prompts, fixed before any run (2026-07-19)

Authored blind after the 6/6-equivalent milestone (PRs #385/#386/#387/#388/#397 on main).
NONE of these prompts were used in any prior gate. ZERO tuning / code changes are allowed
during the run — this corpus measures generalization, not the dev-set. Fails are the data.

Categories per prompt: [chart] [table] [select] [action] [format] [vague] [impossible→honesty]

## demo-bank (Maple) — prompts M1–M15

- M1. "show me my account balances at a glance" [vague]
- M2. "a dashboard of my monthly cash flow with income vs spending" [chart][format]
- M3. "list my upcoming scheduled payments and let me cancel one" [table][action]
- M4. "a card spending tracker grouped by merchant" [table][format]
- M5. "help me find any duplicate or suspicious charges" [table][vague]
- M6. "a savings goal tracker for a $10,000 vacation fund" [chart][format]
- M7. "compare my spending this month vs last month" [chart][format]
- M8. "a quick-transfer widget for moving money to savings" [select][action][format]
- M9. "show my largest 10 transactions this year with details" [table][format]
- M10. "a budget view: how much I have left to spend this month per category" [table][chart][format]
- M11. "an app to pay my credit card bill" [action][select][format]
- M12. "a currency converter for my balances" [impossible→honesty (no FX tool)]
- M13. "show my crypto portfolio" [impossible→honesty (no crypto tools)]
- M14. "a net worth trend chart with account breakdown" [chart][table][format]
- M15. "a form to add a new payee and send them $50" [action][impossible-or-multi-step→honesty]

## demo-accounting (Cadence) — prompts C1–C15

- C1. "a client health dashboard: who's behind on documents" [table][chart][vague]
- C2. "show all clients with their assigned staff and deadlines" [table][format] (object cells!)
- C3. "a document collection progress board grouped by status" [table][format]
- C4. "an app to message a client about their missing documents" [select][action]
- C5. "a workload view: how many clients per staff member" [chart][table]
- C6. "show filing deadlines on a timeline for the next 90 days" [chart][format]
- C7. "a client onboarding checklist app" [vague][action-honesty]
- C8. "help me prioritize which clients to chase this week" [table][vague]
- C9. "a payroll summary dashboard" [impossible→honesty (no payroll tools)]
- C10. "an invoice aging report with totals by bucket" [impossible→honesty (no invoice tools)]
- C11. "show me each client's contact info as cards with a quick message button" [action][format]
- C12. "a season progress tracker: percent of documents collected firm-wide" [chart][format]
- C13. "a form to update a client's filing deadline" [action-or-honesty (check host tools)]
- C14. "compare document completion rates across staff members" [chart][table]
- C15. "an end-of-week status report I can send to the team" [vague][action-honesty]

## PASS bar (same as the final gate — judge each honestly)
Real app of host/prewired components + real data or HONEST empty-state/disclaimer when the
host lacks the tool + working chart where asked + Selects populated with real {value,label}
+ money/dates formatted (no raw cents/ISO) + zero raw-brace/object cells + actions carry
payloads and fire (approval-gated is a PASS) or honest disclaimer + no error box/blob.
[impossible] prompts PASS only via honest handling — a fabricated app is a FAIL.
Record timing (submit → app visible) for every prompt.
