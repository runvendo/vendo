---
"@vendoai/automations": patch
---

Internal restructuring only — **the public surface is unchanged**. `createAutomationsEngine` was one 1,980-line closure inside a 2,499-line file; it is now a 13-line assembler over 18 modules, each holding one concern (app rows, arming, grants, run rows, the §9.9 sponsorship gate, grant capture, run execution, and the five public-door surfaces). Every helper moved verbatim; the row shapes it persists, the queries it issues and the sentences it writes are byte-identical, and 07 §1's exported `createAutomations`/`AutomationsConfig`/`AutomationsEngine` are untouched. No test file changed.
