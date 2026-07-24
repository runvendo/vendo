# Demo Hosting (Milestone 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Milestone 3 of the demo-creator spec: generated demos live at `demos.vendo.run/[id]` — one Railway service per demo (app-sleep), an always-on router service with the registry (id → target, expiry, kill switch), Cloudflare DNS, and expiry teardown tooling. Proven by deploying the verified Linear demo end-to-end.

**Architecture:** The router is a zero-dependency Node service in `tools/demo-router/` (deliberately OUTSIDE the pnpm workspace so it deploys standalone; tests via `node:test`). Registry = atomic JSON file on a Railway volume, single instance. Demos deploy from the monorepo working tree via `railway up` with a parametrized Dockerfile (demo-bank's turbo-filter pattern), so untracked scratch demos are deployable without committing them. Deploy/reap automation lives beside the other creator tooling in `bench/src/demo-creator/`.

**Decisions:**
- Router routes with 302 redirects (not reverse proxy) per the approved spec; expired/killed/unknown ids get a small branded page with the CTA instead of a broken link.
- Admin API (add/list/kill/extend) behind a `ROUTER_ADMIN_TOKEN` bearer token; no public listing of demos.
- Railway project `vendo-demos`: router service (always-on) + one service per demo (app-sleep on). Demo services get `ANTHROPIC_API_KEY` (+ optional `VENDO_DEMO_MODEL`) via Railway variables.
- DNS: `demos.vendo.run` CNAME (DNS-only) → the router service's Railway domain target, created via the existing Cloudflare API creds.
- Expiry: router stops routing at `expiresAt` (from registry) automatically; `demo:reap` tooling deletes expired Railway services + registry rows. Scheduling the reap is milestone 4 (mini routine).

## Task 1: Router service (TDD via node:test)
- [ ] `tools/demo-router/` — `server.mjs` (http server: `GET /healthz`, `GET /:id` 302/expired-page/404-page, admin CRUD under `/admin/demos` with bearer auth), `registry.mjs` (atomic JSON file store, expiry logic), `package.json` (no deps, `node --test`), `Dockerfile`, `README.md`
- [ ] Tests green; commit

## Task 2: Deploy + reap tooling in bench
- [ ] `bench/src/demo-creator/deploy.ts` (`demo:deploy -- --app apps/demo-<id>`): writes the parametrized Dockerfile + .dockerignore into the app, drives the Railway CLI (service create/link, variables, `railway up`, domain), then registers the demo with the router admin API (url, prospect, expiresAt from demo.config)
- [ ] `bench/src/demo-creator/reap.ts` (`demo:reap`): lists registry, deletes expired demos' Railway services + registry rows (dry-run by default)
- [ ] TDD the pure parts (arg parsing, Dockerfile rendering, expiry selection); Railway CLI calls proven live in Task 3; commit

## Task 3: Live bring-up (ops, main session or supervised)
- [ ] Railway project `vendo-demos`; deploy router with volume + `ROUTER_ADMIN_TOKEN`; router Railway domain live
- [ ] Cloudflare: `demos.vendo.run` custom domain on the router service + CNAME record; HTTPS resolves
- [ ] `demo:deploy` the verified `apps/demo-linear`; registry row created; `https://demos.vendo.run/linear` 302s to the live demo; live-browser e2e: panel loads, one real agent turn, caps/badge intact — screenshots kept
- [ ] Kill-switch + expiry behavior exercised against the live router (flip row, confirm page)

## Task 4: Docs + review + PR update
- [ ] PLAYBOOK gains a deploy stage (post-verification); bench README + spec cross-links
- [ ] Combined spec+quality review of Tasks 1-2 code; fixes; commit; push branch (PR #316 grows into the full demo-creator PR)
