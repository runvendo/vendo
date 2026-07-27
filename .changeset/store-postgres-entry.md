---
"@vendoai/store": minor
---

New `@vendoai/store/postgres` entry point: the same store (schema, records, blobs, secrets, helpers) with a `createStore` that requires a Postgres `url` and keeps `@electric-sql/pglite` out of the module graph entirely. The main entry is unchanged — PGlite stays the zero-config dev default — but serverless consumers on a real Postgres (Cloudflare Workers, Lambda, Vercel) should import from `@vendoai/store/postgres` so their bundles stop carrying megabytes of wasm Postgres they can never execute (a console Worker in the field silently crossed Cloudflare's bundle size ceiling this way). Purity is enforced by a new portability-gate leg (node-resolution esbuild metafile over `dist/postgres.js`) and a PGlite import tripwire test.
