# demo-template

`demo-template` is the skeleton a future demo-creator agent clones and
rewrites for each sales prospect. It ships only invisible plumbing — build
tooling, lint/test config, and the minimal Next.js scaffolding needed to boot
— with no brand, product surface, or Vendo wiring baked in.

Everything visible (pages, components, styling, copy, seed data) is a
placeholder the creator agent replaces. Vendo itself is not wired up yet: no
`src/vendo` and no API routes. The committed `.vendo/catalog.json` /
`.vendo/tools.json` are the *empty output* of `vendo sync .` (run
automatically in `predev`/`prebuild`), committed so builds leave the tree
clean. The real product contract lands in a later pass.

## Setup

```bash
cd apps/demo-template
pnpm dev
```

Open http://localhost:3000. Run `pnpm test` for the (currently trivial) test
suite.
