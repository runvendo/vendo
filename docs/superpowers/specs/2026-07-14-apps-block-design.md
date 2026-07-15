# Apps Block: Remix, Custom Fields, Execution Venues — Design

Date: 2026-07-14. Owner: Yousef. Linear project: "Block: @vendoai/apps — remix, custom fields, execution venues" (ENG).
All decisions below were made by Yousef in the brainstorm session; children do not re-litigate them.

## Goal

The apps block fully implements its vision: remix accuracy (extracted source + runtime fallback), custom fields via app data, and the three execution venues on two axes — each with serious end-to-end tests and real captured demos.

## Audit summary (what exists today)

Four sub-agents read the whole package against `docs/contracts/06-apps.md` and the app-format spec:

- **Remix**: static source extraction at sync works and is tested; export fails-not-strips works. Missing: any edit path that consumes captured source, ship/approval runtime (types are dead schemas), furnished jail (jail exposes only React), drift→rebase, runtime fallback, remixable wiring in the demos, init codemod remix offering.
- **Custom fields**: only the per-user `state` singleton is live. Record collections have no read/write path anywhere; `refs: host.<entity>` is validated but never consumed; no join, no agent data tool, no tree binding, no demo.
- **Venues**: E2B + Modal implement the SandboxAdapter seam with two real bugs (E2B forks share one live machine; Modal resume in a fresh process drops egress/env — fail-open). Secrets are non-functional (handles never substituted; SecretsProvider unconsumed). Rungs 3–4 tested only on the fake sandbox; conformance never runs against real adapters; OSS ships with no venue wired; rung-4 generation hard-blocked; no Cloud adapter.
- **Artifact/lifecycle**: solid, adversarially tested. Known hole: `history()` has no in-block ownership check (frozen signature) — the umbrella wire route must enforce it; this project verifies that it does.

## Locked decisions

1. **Venue model — two axes, three venues.** Trust axis: app UI renders in the sandboxed iframe by default; in-client in the host page only when host-approved; approval pins the content hash; new versions re-approve. Capability axis: app backend code always runs in the server sandbox regardless of trust — host adoption never moves app code into the host's servers.
2. **In-client split.** OSS carries the enforcement machinery: approval record format, hash-pin verification, host-page mount, drop-back-to-iframe when the version changes. Cloud owns the human review console that mints approvals. Demos inject approval records via a documented API/CLI.
3. **Remix accuracy bar.** Visual parity screenshots vs the host original plus live demo journeys, on the real demo hosts. When static extraction cannot resolve a component's source, the fallback is **runtime source capture**; silent skips are eliminated.
4. **Custom fields.** Full substrate. Per-user fields ship working in OSS. Org-shared fields use **org-install mode** (one shared app instance per org) and are Cloud-gated: this repo ships shapes + `cloud-required` errors (same pattern as share/publish); machinery lands in the Cloud repo. Writes to shared fields are host-policy gated (shape defined here).
5. **Secrets are in scope.** Substitution must happen at an egress gateway outside the sandbox. The venues child writes a short design doc comparing (a) TLS-terminating gateway (injected CA, HTTPS_PROXY, app code unchanged) vs (b) explicit egress endpoint/fetch shim, including how each provider hosts the gateway. **Yousef picks before implementation.**
6. **Venues extras, all in scope**: rung-4 graduation unblocked + served-app scaffold that bakes in the tree renderer (invisible graduation); auto venue selection from env keys + doctor guidance; env-gated live test lanes for rungs 3–4 on both E2B and Modal through the real runtime; Cloud SandboxAdapter stub behind the frozen seam.
7. **Bugfix wave first** (already running): E2B fork isolation, Modal resume durability, adapter conformance against real providers, fake-sandbox semantics aligned so it stops masking these bug classes.
8. **Demo slate — all mandatory, real browser, captured GIFs in PRs**: (1) Cadence custom fields (priority on invoices, joined UI, survives reload); (2) Maple remix journey with parity screenshots; (3) in-client promotion end-to-end (ship-diff → injected approval → hash-pinned host-page mount → new version drops back to iframe); (4) invisible graduation on real E2B.
9. **Execution structure**: three child sessions in parallel, milestone-sized PRs, parent brokers merge order across shared packages. `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before every PR; UI changes browser-verified with screenshots.

## Sub-projects

### A — Remix + in-client venue
Pin edit loop on captured source; furnished jail (host sub-components, styles, stubbed data); runtime source-capture fallback; ship-diff computation against baselines; approval enforcement (hash pinning, host-page mount, version-drop); drift→rebase; remixable wiring in Maple and Cadence; init codemod actually offers remix wrapping; parity screenshots + demo GIFs (slate items 2 and 3).

### B — Custom fields substrate
Read/write paths for record and file collections (proxy routes + agent data tools); refs-based join usable from rung-1 trees (tree binding for app data joined onto host tool results); Cadence priority demo (slate item 1); org-install shapes + cloud-required; shared-write policy shape.

### C — Execution venues
Secrets gateway design doc → Yousef's pick → build; rung-4 unblock + scaffold; auto venue selection + doctor; live conformance and rung-3/4 lanes on E2B and Modal; Cloud adapter stub; invisible-graduation demo (slate item 4); verify the umbrella enforces `history()` ownership.

## Deferred to child-level design

Jail dependency set (fixed vs per-host); runtime-capture mechanism; join query encoding; secrets gateway shape (returns to Yousef). Anything cut during execution is filed as a Linear issue, never silently dropped.

## Cloud alignment (standing agenda)

Approval review console, org-install machinery, Cloud sandbox adapter, and secrets gateway hosting are the four Cloud touchpoints; each child records the interface Cloud will implement.
