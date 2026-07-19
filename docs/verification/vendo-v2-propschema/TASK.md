# TASK — browser gate for the prewired prop-schema fix (branch yousefh409/vendo-v2-propschema)

RESUMABLE: this environment tears sessions down periodically. Commit each screenshot + README row the INSTANT you capture it, and resume from the README if restarted. Never batch.

## What changed (what you are verifying)
Commit af33f979 gives the model the prewired primitives' exact prop schemas (Table→`rows`, Select→`options:[{value,label}]`, Button→`onClick`, etc.) in the generation prompt, and rejects unknown prop names on prewired nodes → existing repair loop. Prior generalization run was 2/6 (see docs/verification/vendo-v2-generalize on main). The dominant failure was the model inventing prop names (`data` vs `rows`, `labelKey`/`valueKey`, `onPress` vs `onClick`) the renderer silently drops. This fix targets EXACTLY that class.

DO NOT expect this fix to fix: #5 (island importing `recharts` → jail rejects) or the action-payload gap (#4/#6 buttons carry no per-row/form args). Those are separate deferred follow-ups. Report them as fails if they still fail — that is correct and expected.

## Setup
- Branch: yousefh409/vendo-v2-propschema (already has the fix + a green build/test/typecheck/lint). Keys: /Users/yousefh/orca/workspaces/flowlet/.env — copy the needed model key into a gitignored .env; NEVER commit keys.
- Boot each host once and leave it running for that host's 3 prompts. `next dev` is acceptable and faster than prod for this correctness check (prop names, real data, no error box) — note in the row that it was dev. If Cadence PGlite breaks under Turbopack, add `@electric-sql/pglite` to serverExternalPackages (packaging fix, not tuning).
- Drive the real Apps create path (POST /api/vendo/apps is fastest) in a real browser, let it render.

## Matrix (ONE AT A TIME, in order) — same 6 as the prior run
- demo-bank (Maple): (1) "spending breakdown by category this month with a chart"; (2) "a filterable list of recent transactions"; (3) "a form to transfer money between two accounts".
- demo-accounting (Cadence): (4) "overdue invoices with a reminder button"; (5) "a revenue vs expenses summary with a chart"; (6) "a new-client intake form".

## Per prompt
Generate → render → screenshot → judge PASS/FAIL HONESTLY (PASS = real app of host/prewired components + real data or honest empty-state + working chart where asked + NO error-box/blob/raw-braces + prewired Table/Select/Button actually populated/wired). THEN IMMEDIATELY: save screenshot to docs/verification/vendo-v2-propschema/NN-<host>-<slug>.png, append a row `# | host | prompt | PASS/FAIL | note (call out specifically whether the prewired prop-name class is now fixed: does Table use rows and render data? does Select show real labels? does Button use onClick?)` to docs/verification/vendo-v2-propschema/README.md, and git add + commit RIGHT AWAY. Do NOT tune anything to force a pass.

## When all 6 done
Write the Summary (N/6 pass; explicitly compare to the prior 2/6; state whether the prop-name class is resolved; list any remaining fails and which are the known deferred follow-ups vs new regressions). Set worktree/agent comment "PROPFIX GATE: N/6 pass (<one-line>)". Open an evidence PR from this branch, self-triage AI reviewers, merge if green. If a host won't boot, commit what you have and note "BLOCKED: <what>". Keep it simple. Start now (or resume from the README).
