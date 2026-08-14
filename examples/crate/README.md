# Crate

Crate is a self-contained order-ops console for a small online store: orders,
customers, inventory, and shipments, with a deterministic seed built around one
story — **a customer charged twice for the same espresso machine, three minutes
apart. One copy was delivered; the other never shipped.** Refunding the second
charge is the thing the app exists to make easy, and the thing a Vendo agent
should be able to do end to end.

## Setup

```bash
cd examples/crate
pnpm dev
```

Open http://localhost:3000. No environment file is needed yet — Crate has no
external dependencies and boots straight into the seeded store.

```bash
pnpm test    # 55 tests: the seed's invariants and every domain rule
pnpm build   # production build
```

## The demo story

`buildSeed()` produces ~85 orders across 90 days, 12 customers, 10 products and
~75 shipments, then stages the duplicate charge on top. The order numbers are
derived from the generator's draw sequence, not hardcoded, so **read them from
`seed.story`** rather than from any number written down here:

```ts
const { deliveredOrderNumber, duplicateOrderNumber, customerId } = getStore().story
```

`POST /api/demo/reset` puts everything back after someone has refunded their way
through the story. It is restricted to the demo's own origin.

## Architecture

`src/server/` is the whole domain and owes nothing to Next: `seed.ts` and
`prng.ts` build the deterministic world, `store.ts` holds it, and
`orders.ts` / `customers.ts` / `inventory.ts` / `shipments.ts` / `refunds.ts`
are the rules. Money is **always integer cents** — never floats.

Rejections are thrown as a `DomainError` carrying `not_found`, `bad_request` or
`conflict`, and `fail()` in `http.ts` is the single place routes turn one into a
response. The messages are written to be read aloud to a customer, so they go
back verbatim: *"CR-1084 is delivered and can no longer be cancelled. Refund it
instead."* Anything that is not a `DomainError` is a real bug and becomes a 500.

`src/app/api/` is the REST surface, and it is the important part: `vendo init`
extracts these routes into the agent's tool list, so a vague route becomes a
vague tool. Every route takes its arguments from **either** the query string or
a JSON body, because the extracted binding's `argsIn` may guess either one.

Lookups take the reference a human would quote, not just the internal id:

| Route | Also accepts |
| --- | --- |
| `/api/orders/:id` | the order number, `CR-1084` |
| `/api/customers/:id` | the customer's email |
| `/api/products/:id` | the SKU, `CRT-ESP-01` |
| `/api/shipments/:id` | the tracking number, or the order id/number |

Screens are server components reading the domain directly; the write buttons are
small client components that post to Crate's own REST API — the same routes the
agent will call. If a button works, the agent's tool works.

### Writes

| Route | What it does |
| --- | --- |
| `POST /api/orders/:id/fulfill` | paid → fulfilled (picked and packed) |
| `POST /api/orders/:id/cancel` | stops an unshipped order, releases stock |
| `POST /api/shipments` | labels a paid/fulfilled order, ships it, decrements stock |
| `POST /api/shipments/:id/events` | records a carrier scan; `delivered` closes the order |
| `POST /api/products/:id/adjust-stock` | signed delta with a required reason |
| `POST /api/customers/:id/notes` | appends a dated, attributed note |
| `POST /api/refunds` | **irreversible** — money goes back |

Refunds are the ceremony case: the amount defaults to everything still
outstanding, over-refunding is refused with both numbers named, and a full
refund moves the order to `refunded` and drops it out of the customer's lifetime
value.

### The store singleton

`getStore()` hangs its cache off `globalThis`, not a module-level `let`. Next
bundles route handlers and server components separately, so a plain module
variable is instantiated twice: a refund posted through `/api/refunds` landed in
one copy while `/orders/[id]` kept rendering the other, and the page showed
"Paid" for an order the API called "refunded".

## Not wired yet

- **Vendo itself.** `vendo init`, `.vendo/`, `src/vendo/`, and the
  `<VendoProvider>` paste in `src/app/layout.tsx` are still to come.
- **Auth.** `src/server/actor.ts` returns the seeded admin so every write already
  records who did it. It is deliberately one function, so swapping in the real
  Clerk or Supabase session touches one seam.
- **A knowledge corpus.** Store policies — return window, shipping cutoffs,
  warranty — so the agent can answer policy questions with citations.
