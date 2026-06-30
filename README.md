# Flowlet

This is the Flowlet monorepo. Today it contains the Maple demo bank under `apps/demo-bank`. flowlet-core will live alongside it later.

## Layout

```
apps/
  demo-bank/   Maple, a demo consumer neobank and host app for the "$87 Mystery" demo
docs/
  superpowers/ design and plan docs (plans/, specs/)
```

## Quickstart

```bash
cd apps/demo-bank
npm install
npm run dev
```

Open http://localhost:3000.

## More

- `apps/demo-bank/README.md` for the Maple app: stack, architecture, API endpoints, and the planted demo charge.
- `docs/superpowers/` for the design and plan docs.
