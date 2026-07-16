# demo-template

`demo-template` is the skeleton a future demo-creator agent clones and
rewrites for each sales prospect. It ships invisible plumbing — build
tooling, lint/test config, minimal Next.js scaffolding, and the Vendo wiring
below — with no brand or product surface baked in.

Everything visible (pages, components, styling, copy, seed data) is a
placeholder the creator agent replaces. Vendo is wired minimally:

- `src/vendo/server.ts` — `createVendo` with an anthropic model, local
  `.vendo/data` store, anonymous per-visitor principals (no login wall), and
  an empty host-component catalog (a creator seam).
- `src/vendo/theme.ts` + `.vendo/theme.json` — neutral default theme the
  creator overwrites with the prospect's brand.
- `src/server/` — ONE worked example of the fake-host-API pattern (a generic
  `items` entity: deterministic seed, in-memory store, list + archive). The
  creator replaces this whole directory with prospect-domain entities.
- `src/app/api/items/...` + `openapi.json` — the example routes, declared in
  the OpenAPI spec so `vendo sync .` (run automatically in
  `predev`/`prebuild`) exposes them as agent-callable tools in
  `.vendo/tools.json`.
- `/vendo` — the panel page mounting `VendoRoot` + `VendoThread`; demo chrome
  lands in later passes.

Set `ANTHROPIC_API_KEY` (and optionally `VENDO_DEMO_MODEL`) to chat.

## Setup

```bash
cd apps/demo-template
pnpm dev
```

Open http://localhost:3000. Run `pnpm test` for the (currently trivial) test
suite.
