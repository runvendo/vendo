# v2 prewired prop-schema fix — browser gate

Re-test of the same 6 prompts from the 2/6 generalization run
(docs/verification/vendo-v2-generalize on main), now on branch
`yousefh409/vendo-v2-propschema` which carries commit af33f979: the model is
given the prewired primitives' exact prop schemas (Table→`rows`,
Select→`options:[{value,label}]`, Button→`onClick`) and unknown prop names on
prewired nodes are rejected → repair loop. This fix targets EXACTLY the
prop-name class that failed before.

Driven through the real Apps create path (`/vendo/apps` page → Create) in a
real browser, **production boot** (`next build && next start`,
`NODE_OPTIONS=--max-old-space-size=3072`). Both hosts needed
`@electric-sql/pglite` added to `serverExternalPackages` (PGlite WASM breaks
under Turbopack production chunking — `f.instantiateWasm is not a function`);
packaging fix, not generation tuning. No tuning between runs — fails reported
as fails.

| # | host | prompt | verdict | note |
|---|------|--------|---------|------|
| 1 | demo-bank | spending breakdown by category this month with a chart | PASS | Real composed app: donut chart with real category segments + companion **prewired Table now POPULATED with real rows** (housing 285000, shopping 61749, transport 56206, subscriptions 33547, dining 19540, groceries 12661, coffee 3008). PROP-NAME CLASS FIXED: prior run's companion table said "No data" (bound to `data`); it now uses `rows` and renders real data. Caveat (unrelated formatting): amounts shown as raw cents ("AMOUNT (CENTS)"), donut total `$471,711.00` treats cents as dollars — units bug, not prop-name. `01-demo-bank-spending-breakdown.png` |
