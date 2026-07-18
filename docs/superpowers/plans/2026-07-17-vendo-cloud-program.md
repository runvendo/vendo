# Vendo Cloud Program — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan lane-by-lane. Steps use checkbox (`- [ ]`) syntax for tracking. Per Yousef's rules this plan is high-level: goals, steps, and decisions — implementation details live with the executing lane.

**Goal:** Make Vendo Cloud real end-to-end under the locked definition: clean seams first, then the zero-config dev bundle (managed inference, managed sandbox, hosted store) shipped as adapters.

**Architecture:** Governed by `docs/superpowers/specs/2026-07-17-vendo-cloud-definition-design.md`. OSS blocks talk to infrastructure only through per-block adapter interfaces; Cloud is one implementation of each, selected by `VENDO_API_KEY` when no explicit adapter is passed. Cloud endpoints authorize with exactly two checks (valid key, meter not exhausted). No entitlement protocol, no validate endpoint, no capability flags anywhere.

**Repos:** `runvendo/vendo` (OSS) and `runvendo/vendo-web` (console). Every lane ends with both repos' gates green (`build`, `test`, `typecheck`, `lint`), the cloud E2E suite passing, and a PR — never a commit to main.

**Sequencing:** Lane 0 merges before any other lane starts (it changes the seams the others build on). Lanes 1 and 2 then run in parallel — they are what v2's ~5s launch bar stands on. Lane 3 follows. Lane sizing assumes one worker session per lane.

---

## Lane 0 — Realignment (both repos)

Deletes the license-server era. No new features; the product behaves identically for every existing user.

- [ ] Reply to PR #355: accept, with open question 3 amended from per-plan flag to "valid key + storage quota"; questions 1 and 2 accepted as suggested. Merge it as a doc.
- [ ] OSS: delete the entitlement protocol — contract types, entitlements module, entitlements cache, the `vendo cloud validate` command, and capability/plan display in doctor. Doctor's cloud step shrinks to: key present and well-formed, or one calm line when absent.
- [ ] OSS: rewrite `createConnections` from the hidden key-switch to explicit adapter selection (the Cloud broker becomes an ordinary adapter that is the default when a key is set and none was passed). This is the reference implementation of the adapter rule for later lanes.
- [ ] OSS: the shared cloud HTTP client attaches the deployment-identity header (host, name) to every request.
- [ ] Console: drop the plan `capabilities` column and plan-capability resolution; the share/publish/pin-ship checks become valid-key checks; delete the validate route.
- [ ] Console: shared auth middleware upserts the deployment inventory and meters usage from real service calls (replacing validation-count usage).
- [ ] Docs: adapter rule + two-category split written into both repos' CLAUDE.md and the integration docs; retire `persistence-and-deploy.md`'s and the cloud CLI help's references to validate.
- [ ] Acceptance: zero references to capabilities/contract/validate in either repo; existing paid flows (share, publish, pin-ship, deploy) still work in the cloud E2E suite; deployments/usage console pages populate from real traffic in a test-mode run.

## Lane 1 — Managed inference (the $0 → paid moment)

Cloud-provided model access so `vendo init` works with no model key. First half of v2's launch bar.

- [ ] Define the OSS inference adapter interface (the seam the agent block already implies via its model parameter); BYO = today's model-key path expressed as an adapter; Cloud = a thin client against the console.
- [ ] Console: inference endpoint that proxies to the model provider, keyed by org, metered as managed-LLM passthrough (the fourth pricing-v2 meter). Streaming must pass through untouched — generation latency is the whole point.
- [ ] Console: implement the parked starter-key endpoint exactly per the hand-off contract already written in `cloud-init.ts` (user-session auth, returns a metered dev-mode key scoped to the caller's default org).
- [ ] OSS: un-park the `vendo init` cloud step — offer `vendo cloud login`, mint the starter allowance, write it to `.env.local`; the existing graceful degradation stays for older consoles.
- [ ] Acceptance: a clean Next.js app + `vendo init` + email OTP → working generation with zero external accounts; meter visibly increments in the console; BYO model key still works with no code changes; exhausted meter returns the clear 402-style error on the call.

## Lane 2 — Managed sandbox (second half of the v2 bar)

- [ ] Define the OSS sandbox adapter interface from what v2 generation actually consumes (exec, files, screenshot — the console's sandbox API already speaks these verbs); BYO = the e2b path as an adapter; Cloud = client against the console's sandbox routes.
- [ ] Console: harden the existing sandbox surface for production multi-tenancy — per-org isolation, the sweep job, `sandbox_minutes` metering on real usage.
- [ ] Wire the v2 generation pipeline (format-gen-v2 lane's consumer side) to the adapter interface, not to any concrete sandbox.
- [ ] Acceptance: v2 generation runs against the Cloud sandbox with a key and against BYO e2b without one, through the same interface; minutes meter matches wall-clock within tolerance; sweep reclaims abandoned sandboxes in a test-mode run.

## Lane 3 — Hosted store (#355 implementation)

- [ ] OSS: `hostedStore` — a plain `StoreAdapter` speaking HTTP to the console, per the merged one-pager. `vendo_secrets` excluded by construction (the secrets code keeps requiring a local database; no Cloud endpoint accepts them).
- [ ] Console: the store service — managed Postgres (one-pager Q1: Neon-style, plugged into the existing Cloudflare setup), StoreAdapter-granularity API, tenant = the key's org, blobs through the API for now (Q2), `storage_gb` soft quota (Q3 as amended).
- [ ] Deletion parity: deleting a user wipes everything hosted, same guarantee as local.
- [ ] Acceptance: a demo host runs the full journey (apps, threads, approvals, automations history) against `hostedStore` with a key and against local PGlite without one; cross-tenant access attempts fail in tests; quota exceeded returns the clear error.

## Verification (whole program)

- [ ] Each lane: both repos green, cloud E2E passing, PR with browser screenshots for anything UI-visible (console pages, init flow).
- [ ] Program close: one demo host recorded end-to-end on Cloud-everything (key only) and on BYO-everything (no key) — the two-row proof of the hard BYO rule.
