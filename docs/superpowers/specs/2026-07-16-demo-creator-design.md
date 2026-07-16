# Demo Creator — Design

**Date:** 2026-07-16
**Status:** Approved by Yousef (brainstorm session)
**Goal:** From a prospect's website URL and/or dashboard screenshots, automatically build a bespoke fake version of their product with Vendo embedded, deploy it at `demos.vendo.run/[id]`, record a GIF of the demo beats, and deliver link + GIF to Yousef for approval before it reaches the prospect. Usable manually and by the GTM agent on the mac mini.

## Decisions (locked during brainstorm)

- **Fidelity:** fully bespoke visible product per prospect — not a shared template shell. Everything the prospect sees is generated for them.
- **Generator architecture:** template-seeded. A new `apps/demo-template` holds the invisible plumbing (Vendo wiring, fake-API framework, chips, caps, badge); the creator agent rewrites 100% of the visible product from the prospect's brand and domain.
- **Hosting:** Railway, one service per demo with app-sleep, in a dedicated `vendo-demos` project. A small always-on router service owns `demos.vendo.run` and redirects `/[id]` to the demo's Railway domain.
- **Gating:** open link, no login. Protection is hard caps, expiry, and kill switches. Caps set low: ~20 agent turns and a modest token budget per demo, 14-day default expiry (all configurable per demo).
- **Review gate:** the agent builds and rigorously self-verifies; Yousef receives link + GIF + verification summary and approves before anything is sent to a prospect. Nothing ships autonomously.
- **Demo story:** fixed 3-beat arc with per-prospect prompts — (1) prompt → branded interactive UI generated live, (2) agent takes a real action through the fake host API with a consent card, (3) result saved as a reusable app. The same prompts become the live demo's suggestion chips.
- **MCP-door beat** (prospect's product driven from an external agent via Vendo's MCP door, for "we already have a copilot" prospects): reserved as a v2 variant behind a flag; not built initially.

## Inputs

- Required: prospect name, plus website URL and/or one or more dashboard screenshots.
- Optional: outreach notes (feed prompt/domain generation), the v2 `--mcp-beat` flag.
- URL-only runs screenshot the site themselves (headless Playwright) and infer a plausible dashboard from the domain; user-supplied dashboard screenshots remain the high-fidelity path.

## Components

### apps/demo-template

A minimal Next.js host (stripped Maple sibling) containing only plumbing that must never break: wired Vendo handler/panel/theme seam with our key server-side; the Maple/Cadence fake-API pattern (in-memory seeded store + typed host API routes) with an empty schema; suggestion chips driven by a per-demo `demo.config` (prompts, prospect name, expiry, caps); caps middleware with a friendly "demo limit reached — book a call" state; a visible Vendo-demo badge and "Get this in your product" CTA linking to cal.com/yousefhelal; no login wall. Includes a `VERIFY.md` contract listing what the creator must prove before a demo is done. The template stays in CI (build/test/typecheck) so template rot is caught before it poisons demos.

### Creator pipeline

An agent session in a scratch workspace; generated demos live in a separate `runvendo/demos` repo, one directory per demo (audit trail). Stages:

1. Research: screenshot/crawl the prospect site; extract brand tokens (colors, type, logo, radius) and product domain (entities, actions, vocabulary).
2. Clone template and rewrite the entire visible product: nav, pages, dashboard widgets, entity tables, realistic domain-shaped seed data.
3. Fill the fake API with 5–10 host actions in their domain (what the Vendo agent acts through).
4. Write the beat prompts for the fixed arc, domain-specific per prospect; wire them as suggestion chips.

### Self-verification + GIF (one step)

GIF capture is the verification. Extend `bench/demo-capture` (today hardcoded to maple/cadence in `hosts.ts`) with a generic host adapter driven by `demo.config`. A demo passes when: build succeeds; app boots with zero console errors on load; each beat prompt runs live and hits its marks (first paint, usable, consent card shown) — that recording becomes the GIF; the creator compares its screenshots against the prospect originals and self-scores brand fidelity; seed data passes an "uncanny data" review. Failed beats are fixed and rerun; after 3 failed attempts on the same beat the run escalates to Yousef instead of shipping. Outputs: email-sized hero GIF, per-beat GIFs, screenshots.

### Router + registry

One always-on Railway service owns `demos.vendo.run` (DNS via existing Cloudflare creds). It holds the demo registry — id, prospect, service URL, expiry, kill switch, usage counters — and 302-redirects `/[id]` to the demo's Railway domain. The registry is the single control point: killing a demo is flipping a row. Redirect, not reverse proxy, to keep Next.js routing simple; the pretty link is the one that gets sent.

### Guardrails

Per-demo turn cap (default 20) and token budget (default roughly $5 of model spend) enforced in the demo app; 14-day default expiry after which the router stops routing and the service is torn down (scheduled cleanup); per-demo and global kill switches; every demo watermarked as a Vendo demo with fake data.

### GTM agent packaging

A `demo-creator` skill on the mac mini: takes prospect name + URL/images from an outreach thread, spawns the creator session in an Orca workspace, waits, then iMessages Yousef link + GIF + one-line verification summary. Approve/fix reply gates any send to the prospect. Cost per demo: one 20–40 min agent session plus ~$0–5/month Railway while alive.

## Out of scope (v2+)

MCP-door beat, self-serve on the website, email gating / lead capture, demo analytics beyond usage counters, custom per-demo subdomains.

## Build order (each independently PR-able)

1. `apps/demo-template` + generic host adapter in `bench/demo-capture`.
2. Creator pipeline as a repo skill/CLI; run manually end-to-end on one real prospect.
3. Router service + Railway deploy flow + DNS + expiry cleanup.
4. Mac-mini `demo-creator` skill + approval loop.
5. First real outreach demo as the acceptance test.
