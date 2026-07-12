# Seeded invoice host fixture

This is a minimal standalone Next.js app used by Vendo wave-3 tests. It has a deterministic in-memory invoice store, a plain cookie session, an OpenAPI file for extraction, and intentionally shaped routes for route-scan coverage. It does not import from the repository's legacy apps or packages.

## Seed data

All seed invoices use `2026-07-01T00:00:00.000Z` as `createdAt`. Open seed invoices use `2026-07-01T12:00:00.000Z` as `sentAt`.

| Invoice | Customer | Amount | Status | Memo |
| --- | --- | ---: | --- | --- |
| `inv_0001` | Ada Lovelace (`cus_ada`, `ada@example.test`) | $125.00 | paid | Analytical engine consultation |
| `inv_0002` | Ada Lovelace (`cus_ada`, `ada@example.test`) | $48.00 | open | Algorithm review |
| `inv_0003` | Ada Lovelace (`cus_ada`, `ada@example.test`) | $32.00 | draft | Technical notes |
| `inv_0004` | Bob Noyce (`cus_bob`, `bob@example.test`) | $250.00 | paid | Semiconductor workshop |
| `inv_0005` | Bob Noyce (`cus_bob`, `bob@example.test`) | $99.00 | open | Prototype review |
| `inv_0006` | Bob Noyce (`cus_bob`, `bob@example.test`) | $75.00 | draft | Design session |
| `inv_0007` | Cleo Chen (`cus_cle`, `cleo@example.test`) | $180.00 | paid | Operations audit |
| `inv_0008` | Cleo Chen (`cus_cle`, `cleo@example.test`) | $61.00 | draft | Planning session |

New invoices start at `inv_9001` and increment deterministically. Calling the reset endpoint restores all seed records and resets that counter.

## Authentication and reset

Sign in by posting JSON such as `{ "user": "user_ada" }` to `POST /api/login`. The response sets `fixture_session=user_ada; Path=/; HttpOnly`; send that cookie on all other `/api` requests. A missing session returns a `401` JSON error.

`POST /fixture/reset` requires no authentication. It restores the seed data and creation counter, and it lives outside `/api` so extraction never exposes it as a tool.

## Running the fixture

Wave blocks should start the app on their allocated port with:

```sh
pnpm --filter @vendoai-fixtures/host-app dev -- -p <port>
```

The OpenAPI 3.1 contract is the local `openapi.json` file; the app deliberately does not serve it over HTTP.

## Deliberate extraction cases

- `src/app/api/vendo/[...vendo]/route.ts` is Vendo's mounted route and must be excluded from extracted host tools.
- `src/pages/api/export-data.ts` is an opaque `withReporting(handler)` export. It contains no local HTTP verb evidence, so a scanner must fail closed and emit it disabled.
- `downloadInvoicesArchive` is a real `GET /api/invoices/archive` OpenAPI operation whose name does not begin with a recognized read word. It must not be inferred as read risk merely from its HTTP method.
- `GET /api/reports/summary` is a pure re-export through the `@fixture/*` TypeScript alias (`export { GET } from "@fixture/lib/reports-handler"`), so the scanner must resolve the alias to classify it. Deliberately absent from openapi.json.
- `src/vendo/components.ts` marks only `InvoiceCard` as `remixable: true`. Sync should follow that import and capture `InvoiceCard` source, but not capture `StatusBadge` as its own remixable registration.
