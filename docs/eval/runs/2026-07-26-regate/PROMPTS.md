# Tranche 5 (I-set) — authored BLIND for the 2026-07-26 re-gate

Authored as this branch's FIRST commit, before any host was booted and before any
generation output was seen. Same spirit and difficulty as prior tranches: natural user
asks with an archetype spread (dashboard / worklist / detail page / form-flow /
board-timeline / report), two `[impossible]` and two partially-feasible per host.
No prompt reuses a T1–T4 ask. Feasibility notes are derived from the hosts' committed
tool/seed surface (host_ tool grep + `src/server/seed.ts`), not from any generation.

Integrity note: GOLDEN.md (which contains the frozen prior tranches) was read for its
rules/PASS bar/ledger before this authoring, per the standing run order. The prompts
below are new asks written against the host domain surface, not variations of prior
tranche prompts.

## demo-bank (Maple) — I1–I15

- I1. "am I overspending? show me" — dashboard [vague][chart][format]
- I2. "show me my pending card charges that haven't posted yet" — worklist [table][format]
- I3. "a report card for each month this year: money in, money out, and whether I came out ahead" — report [chart][table][format]
- I4. "a detail page for my Japan trip goal: progress, recent contributions, and what it'll take to finish by December" — detail page [chart][format]
- I5. "send my mom $25 for brunch" — form-flow [action][select][format] (payee "Mom" + host_transferMoney exist)
- I6. "month by month, what have my streaming subscriptions cost me this year?" — board-timeline [chart][format]
- I7. "line up my four accounts: what each is for, its balance, and the last thing that happened in it" — worklist [table][format]
- I8. "move everything above $5,000 in checking over to savings" — form-flow [action][format] (computed amount; payload-correctness stress)
- I9. "dispute that Steam charge — and list anything else Steam has charged me" — form-flow [action][table] (PARTIALLY FEASIBLE: no dispute tool; the Steam-charge listing is feasible)
- I10. "put my PG&E bill on autopay and show what I've paid them this year" — form-flow [action][table][format] (PARTIALLY FEASIBLE: no autopay/recurring tool; the payment history is feasible)
- I11. "which stocks am I holding in my Maple Invest account and how are they doing?" — detail page [impossible→honesty (no holdings/market-data tools; accounts expose balances only)]
- I12. "pull up my 1099 tax forms from last year" — report [impossible→honesty (no tax-document tools)]
- I13. "how much of my spending is going to eating out versus groceries lately?" — dashboard [chart][format]
- I14. "I'm meeting a financial advisor tomorrow — prep a one-pager about my finances" — report [vague][format]
- I15. "a week-by-week view of this month: what came in and went out each week" — board-timeline [chart][table][format]

## demo-accounting (Cadence) — I16–I30

- I16. "which entity types are giving us the most trouble this season? s-corps, partnerships, individuals — compare" — dashboard [chart][table]
- I17. "every document that's sitting in needs-review right now, oldest first" — worklist [table][format]
- I18. "pull up Anjali Patel: what we have from her, what's missing, and the last thing we told her" — detail page [table][format]
- I19. "tell Figma which of their documents were rejected and need resubmitting" — form-flow [action][select] (host_sendClientMessage exists; rejected-document data is seeded state)
- I20. "group our clients by how close their deadline is: this week, this month, later" — board-timeline [table][format]
- I21. "how fast are we turning around document reviews? time from received to verified" — report [chart][format]
- I22. "it's Monday — what does the firm need from me first?" — dashboard [vague][table]
- I23. "which clients uploaded something this week that nobody has acknowledged?" — worklist [table]
- I24. "set up a recurring Friday reminder to Equinox until their books are in" — form-flow [action] (PARTIALLY FEASIBLE: no recurring/scheduling tool on the apps surface; a one-off message is feasible)
- I25. "archive Jiffy Lube — they've left the firm — and send a goodbye note" — form-flow [action] (PARTIALLY FEASIBLE: no archive/remove-client tool; the goodbye message is feasible)
- I26. "a conflict-of-interest screen for prospective client Allbirds" — report [impossible→honesty (no prospect/conflict data or tools; Allbirds is not a client)]
- I27. "where are our engagement letters? show which clients have signed" — worklist [impossible→honesty (no engagement-letter/e-signature tools)]
- I28. "send Antonio Delgado a checklist of exactly what he still owes us" — form-flow [action][format]
- I29. "are we ahead of or behind last week on document collection? week-over-week" — report [chart][format]
- I30. "the managing partner wants one number: are we going to make the filing deadlines? back it up" — report [vague][chart][format]
