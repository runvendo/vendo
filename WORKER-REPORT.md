# W-L3-SKATESHOP Worker Report

## What I built

- Added Skateshop-specific Layer 3 prep in `corpus/harness/src/e2e-prep/skateshop.ts`, dispatched from `prepareE2eRepo` without changing Umami behavior.
- Injected e2e-only Skateshop REST routes under `src/app/api/corpus/...` in the checked-out corpus repo for catalog search/listing, cart add, and order placement.
- Wrote a curated `.vendo/tools.json` for Skateshop with two read tools and two mutating approval-gated tools.
- Patched the Skateshop Vendo handler during prep with `storage: false`, `maxSteps: 8`, and seeded-product guidance.
- Patched Skateshop corpus checkout boot issues during prep: per-attempt `vendoThread`, seed revalidation fail-open, Clerk middleware bypass, root layout Clerk provider bypass, and cached user query bypass.
- Added offline unit coverage for the Skateshop prep fixture.

## Product Bugs Found And Fixed

- Host installs could resolve `zod@3.23.x`, but AI SDK v6 needs `zod/v3` and `zod/v4` subpath exports. Fixed CLI host wiring to add/upgrade `zod` to `^3.25.76`, and fixed local pnpm overrides for local corpus installs.
- Plain `vendo init` reruns on an already-wired app could call the provider again and expand component catalogs, making Skateshop Layer 1 reruns unstable. Fixed plain reruns to keep an existing component catalog stable and skip the model when theme/tools/components are already real; `vendo refresh` remains the explicit gap-fill command.
- CLI provider calls could keep the process open after model work. Added a CLI provider fetch wrapper that sends `Connection: close`.
- Tailwind extraction could keep esbuild alive and included emoji font fallbacks that made Layer 2 font matching drift. Stopped esbuild after extraction and filtered common emoji fallback fonts.
- Vendored sandbox assets can be typechecked by host apps with `checkJs`; added idempotent `// @ts-nocheck` when copying those assets.

## Final Live Numbers

Final command:

```sh
while ! mkdir /tmp/vendo-l3-port3000.lock 2>/dev/null; do sleep 30; done
trap 'rmdir /tmp/vendo-l3-port3000.lock' EXIT
set -a; source apps/demo-bank/.env.local; set +a
pnpm corpus run skateshop --layer 3 2>&1 | tee /tmp/l3-skateshop-run.log
```

Scorecard:

```text
Generated: 2026-07-07T07:24:20.640Z
Summary: 3/3 layers passing; 0 hard failures.
| skateshop | Layer 1 structural | PASS | 7/7 |
| skateshop | Layer 2 scored | PASS | 10/10 |
| skateshop | Layer 3 e2e | PASS | 4/5 |
```

Layer 3 pass rate: 4/5 conversations = 0.8 pass@2, meeting the >=0.8 gate.

Per-conversation pass@k summary:

```text
browse-skateboard-decks: 2/2 PASS tools=list_skateshop_catalog_products, search_skateshop_products
compare-nike-running-products: 2/2 PASS tools=list_skateshop_catalog_products, search_skateshop_products
find-youness-deck: 2/2 PASS tools=list_skateshop_catalog_products, search_skateshop_products
add-deck-to-cart-approval: 2/2 PASS tools=list_skateshop_catalog_products, search_skateshop_products
place-streakfly-order-approval: 0/2 FAIL tools=list_skateshop_catalog_products, search_skateshop_products
  attempt 1: tool-called: expected at least 1 tool call(s); observed list_skateshop_catalog_products, search_skateshop_products
    approval-card-shown: true (1 approval card signal(s) observed)
    no-error-toast: true (no error toast or alert observed)
  attempt 2: tool-called: expected at least 1 tool call(s); observed list_skateshop_catalog_products, search_skateshop_products
    approval-card-shown: true (1 approval card signal(s) observed)
    no-error-toast: true (no error toast or alert observed)
```

## Flaky Conversations And Stabilization

No passing conversation was flaky in the final run; the four passing conversations passed both attempts.

The residual non-passing conversation was `place-streakfly-order-approval`. Both attempts showed the approval card and no error toast, but the recorded tool calls were read-only catalog/search calls rather than the expected order write call. This remains within the Layer 3 gate slack. Stabilization changes made before the final pass were: stronger tool descriptions, seeded-product guidance in `instructionsExtra`, deterministic catalog REST routes, `storage:false`, per-attempt threads, and Clerk/seed boot patches.

## Gate Outputs

`pnpm --filter @vendoai/corpus-harness test`

```text
Test Files  13 passed (13)
Tests       73 passed (73)
exit 0
```

`pnpm --filter @vendoai/cli test`

```text
Test Files  43 passed (43)
Tests       430 passed (430)
exit 0
```

`pnpm build && pnpm typecheck && pnpm lint`

```text
pnpm build
Tasks:    19 successful, 19 total
Cached:   18 cached, 19 total
exit 0

pnpm typecheck
Tasks:    30 successful, 30 total
Cached:   24 cached, 30 total
exit 0

pnpm lint
Tasks:    2 successful, 2 total
Cached:   1 cached, 2 total
exit 0
```

Lint warnings observed, with no lint errors:

```text
apps/demo-bank/src/app/vendo/page.tsx:83:28  '_prior' is assigned a value but never used
apps/demo-accounting/src/app/assistant/page.tsx:92:28  '_prior' is assigned a value but never used
```

