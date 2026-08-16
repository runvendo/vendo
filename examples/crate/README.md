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

Open http://localhost:3000. **No environment file is needed.** With nothing
configured Crate boots into the seeded store and acts as the shop owner, so a
fresh clone shows the shop rather than a stack trace about a missing key. Each
line in `.env.example` switches on one more thing: a model key for the agent,
Clerk for real sign-in.

```bash
pnpm test    # 63 tests: the seed's invariants, every domain rule, the roster
pnpm build   # production build (runs `vendo sync --strict --no-ai` first)
npx vendo doctor   # verify the wiring against a running dev server
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

## Vendo

Composed in `src/app/api/vendo/[...vendo]/route.ts`, mounted by the
`<VendoProvider>` + `<VendoOverlay />` pair in `src/app/layout.tsx`.

**The tool surface comes from `openapi.json`.** Without a spec, `vendo init`
extracts the same 18 routes but every one of them arrives *blind* — no input
parameters, no output shape, nothing but a method and a path. The spec is what
turns "18 tools" into 18 tools an agent can actually use, and it is worth more
than anything else in this directory. `vendo sync` reports the difference:

```
tool schemas: inputs 0/18 · outputs 0/18   ← without openapi.json
tool schemas: inputs 18/18 · outputs 18/18 ← with it
```

**Risk is graded by hand** in `.vendo/overrides.json`, which needs no model key:
reads run, writes ask, refunds and cancellations are `destructive`, and
`resetDemo` is disabled outright — an agent helping a customer has no business
discarding the shop's data. Overrides merge at load, so `tools.json` still shows
the extractor's `ungraded`; `vendo doctor` is what confirms the grades landed
("catalog: all 18 tools graded", "17 live host tools" — 18 minus the disabled one).

`.vendo/theme.json` is hand-corrected too, and the reason is worth knowing.
Extraction's deterministic pass reads *shadcn's* token vocabulary —
`--background`, `--foreground`, `--card`, `--primary`, `--border`,
`--destructive` — plus each name's Tailwind-v4 `--color-*` spelling. Crate's
palette is a Tailwind v4 `@theme` block named the Tailwind way (`--color-bg`,
`--color-ink`, `--color-surface`, `--color-accent`), so out of twelve slots it
matched exactly one: `border`, and only because `--color-border` happens to
collide. See `.vendo/theme.extracted.json` — it is the whole record.

The `@theme` block is read fine; it is the *names* that miss. Everything the
allowlist leaves empty rides init's consent-gated model pass, so without a model
key a fully-declared design-token sheet still lands on the neutral blue default.
Naming the tokens after shadcn's vocabulary would have extracted the palette
deterministically. (ENG-418.)

## Identity

Clerk, wired through `clerk()` in the composition. Two rules:

- **Clerk answers "who signed in"; Crate's roster answers "and are they staff
  here?"** The join is on email, because a Clerk subject (`user_2abc…`) means
  nothing to Crate and Clerk's default session claims carry no email — so
  `staffForSubject` asks Clerk's backend once per subject and memoizes it.
- **Everything runs without Clerk.** `clerkEnabled` gates the provider, the
  proxy and the session read, and with it false Crate acts as the seeded owner.

`src/server/actor.ts` is the one seam every write goes through, and it is also
where an unattended run lands: the proxy verifies the `VendoAway` token Vendo
mints in place of a Clerk session, and sets the subject as a trusted header.

The only thing a role decides is refunds — the shop owner may issue one, a
support agent gets a 403 telling them to ask. It is said out loud in the agent's
`[User]` facts rather than left to be discovered by failing.

## Known rough edges

Found while wiring this up. All three are in Linear: ENG-415, ENG-416, ENG-417.

1. **`clerk()` 501s the whole wire when its keys are missing.** Any request
   carrying `Authorization: Bearer …` throws instead of resolving to an
   anonymous principal — including `vendo doctor`'s own probe, which reports
   "Internal Vendo error". `vendo init --auth clerk` leaves you in exactly this
   state before you paste your keys. The same preset returns null for an
   unverifiable token two lines away.

   Crate's half of the workaround is to compose `auth` only when both keys are
   present — but that alone is not enough, because `createVendo` no longer mints
   anonymous sessions. A composition with neither `auth.principal` nor
   `principal` refuses to build at all, and every wire request answers 500 with
   *"createVendo needs an identity"*. So the keyless branch names its actor
   explicitly: the seeded shop owner, the same one `resolveActor()` returns for
   a keyless request. Saying it out loud is better than the anonymous default it
   replaced — the agent and the screens now agree on who is asking.
2. **`vendo init` does not add `serverExternalPackages`.** The composed default
   store is PGlite, whose Emscripten module breaks under Turbopack's production
   chunking — `next dev` is fine and `next build` + `next start` 501s every wire
   request with "f.instantiateWasm is not a function". Every Next example in this
   repo sets it by hand; nothing tells a newcomer to.
3. **`openapi.json` is undocumented.** The extractor looks for it by convention
   in six locations, and it is the single highest-leverage file a host can add.
   It appears in no doc — the only way to find it is to read demo-bank.
