# Use Vendo with Your Existing Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the in-process BYO-agent seam plus two starter-based examples (AI SDK, Mastra), a docs section, and live e2e coverage (fixture, init full-journey, Vendo Cloud) — done, tested, browser-verified, merged.

**Architecture:** Framework-neutral tool-pack core promoted from `buildAgentTools` in `@vendoai/agent`; two thin umbrella subpath shims (`./ai-sdk`, `./mastra`); versioned tool-output envelopes shared through `@vendoai/core`; three embed components in `@vendoai/ui` riding the existing wire; examples under a new `examples/` workspace root.

**Spec:** `docs/superpowers/specs/2026-07-20-existing-agents-design.md` — read it first; decisions there are locked, do not re-litigate.

**Execution model:** Orchestrated orca lanes. Waves are dependency barriers; lanes inside a wave run in parallel in isolated worktrees off `yousefh409/connect-to-agent`. Each lane follows TDD, keeps commits small, and ends with its verification gate green. Final integration is one PR to `main`.

**Rules that bind every lane:**
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before a lane reports done.
- Layering guard (`scripts/dependency-guard.mjs`) must stay green — envelopes go in `core`, tool-pack core in `agent`, shims in the umbrella only.
- UI-affecting work is verified in a real browser with screenshots; tests alone don't count.
- Live keys come from the canonical `/Users/yousefh/orca/workspaces/flowlet/.env`; live tests are env-gated (follow the `VENDO_LIVE_MCP=1` pattern).
- No worker merges anything to `main`; the orchestrator owns integration and the final PR.

---

## Wave 0 — Contract freeze (single lane, blocks everything)

Pin the shared shapes so Waves 1+ can parallelize without drift.

- [ ] Define the tool-output envelope types (`vendo/app-ref@1`, `vendo/approval-ref@1`) with zod schemas in `@vendoai/core`, following the MCP door's versioned-envelope precedent.
- [ ] Define the public tool-pack API signature (options: principal, include/exclude; per-framework return shapes) as types + a written contract note in the spec's directory.
- [ ] Define the embed component prop contracts (`VendoAppEmbed`, `VendoApprovalEmbed`, `VendoToolResult`).
- [ ] Confirm what the wire already supports for parked approvals without a Vendo thread (study the existing approve-resume path); record the gap Lane B must close.
- [ ] Commit; gates green.

## Wave 1 — Seam and surface (two parallel lanes)

### Lane A — Server seam (`@vendoai/agent` + umbrella)

- [ ] Promote `buildAgentTools` into a framework-neutral tool-pack core: guard-bound wrapping, `vendo_*` namespacing, envelope outputs, include/exclude filtering.
- [ ] Add `vendo_create_app` (fast app-ref return; build streams over the wire) and `vendo_delegate` (backed by `agent.asRunner()`).
- [ ] Add the `@vendoai/vendo/ai-sdk` subpath: AI SDK v5 `ToolSet` shim, built per request with a principal.
- [ ] Add the `@vendoai/vendo/mastra` subpath: Mastra tool-shape shim with lazy per-call principal resolution; `@mastra/core` as optional peer dep.
- [ ] Tests: extend the agent conformance suite so every pack tool provably routes through the guard; approval-pending returns the envelope without throwing; shim shape tests against both frameworks.
- [ ] Gates green; report the exact public API shipped.

### Lane B — Embeds and wire (`@vendoai/ui` + wire)

- [ ] Close the Wave-0-identified gap: parked guarded calls (no Vendo thread) that the wire executes on approve, discards on deny, and expires on the existing TTL sweep.
- [ ] Build `VendoAppEmbed` (slot + build-beat machinery), `VendoApprovalEmbed` (approval-card machinery, resolves in place to outcome/declined/expired), and the `VendoToolResult` dispatcher.
- [ ] Failure states render existing failed/expired vocabulary — no silent blanks.
- [ ] Tests for all three plus wire parking; browser-verify the embeds render and theme correctly inside a plain (non-Vendo) chat page; capture screenshots.
- [ ] Gates green.

## Wave 2 — Examples (two parallel lanes, after Wave 1)

### Lane C1 — `examples/ai-sdk-agent`

- [ ] Scaffold the unmodified AI SDK Next.js quickstart chatbot into the workspace (`workspace:*` deps, joins turbo).
- [ ] Apply the four-touch Vendo diff per spec (vendo server file with weather action + risky `sendTripReport` action, wire route, tools spread, provider + `VendoToolResult` case); keep the diff explicitly marked and minimal.
- [ ] README: "unmodified starter plus these lines," demo script, env setup.
- [ ] Fixture e2e: one real turn per value prop — guarded action, app-ref envelope, approval park/approve/execute.
- [ ] Browser-verify the full demo script; capture screenshots (inline app build, approval card, approve-resume).
- [ ] Gates green.

### Lane C2 — `examples/mastra-agent`

- [ ] Scaffold `create-mastra`'s weather-agent starter, fronted per Mastra's Next.js guide (`@mastra/ai-sdk` → useChat + AI SDK UI).
- [ ] Same four-touch diff, tools spread via the `./mastra` shim in `Agent({ tools })`; frontend mirrors C1.
- [ ] README, fixture e2e, browser verification + screenshots — same bar as C1.
- [ ] Gates green.

## Wave 3 — Docs and journey e2e (two parallel lanes, after Wave 2)

### Lane D — Docs

- [ ] New docs-site group "Use with your existing agent": `existing-agents/index.mdx` (positioning, composition, envelope contract, two-models note), `ai-sdk.mdx` + `mastra.mdx` (diff-by-diff, mirroring the shipped examples exactly — verify every claim against the merged lane code).
- [ ] Reference updates: subpath exports; the three components; `docs.json` nav.
- [ ] Cross-links: quickstart/index "already have an agent?" fork; `capabilities/mcp.mdx` aside routes in-process integrators here.
- [ ] In-repo `docs/existing-agents.md` mirror. Succinct throughout, no filler.
- [ ] Gates green (docs-site build included).

### Lane E — Journey + Cloud e2e

- [ ] Full-journey e2e per example, env-gated live: scaffold fresh starter → run current `vendo init` for server wiring → apply the example's marked diff programmatically → boot → drive a live turn to an actual app creation.
- [ ] Vendo Cloud e2e: one example in full Cloud posture (`VENDO_API_KEY` only — managed inference, cloud sandbox, cloud connections) driven to live app creation; assert `/status` reports cloud postures; confirm an explicitly passed adapter still wins (adapter rule).
- [ ] Wire both into the test tree env-gated so default CI stays hermetic.
- [ ] Run both live against real keys at least once; record evidence under `docs/verification/existing-agents/`.
- [ ] Gates green.

## Wave 4 — Integration and merge (orchestrator)

- [ ] Merge all lane branches into `yousefh409/connect-to-agent`; reconcile; full green gate at the root.
- [ ] Fresh end-to-end pass of both examples' demo scripts in a browser; final screenshot set.
- [ ] Code review pass (requesting-code-review skill) + fix findings.
- [ ] Open PR to `main` with browser evidence attached; CI green; merge.
- [ ] Sync memory file with outcome and any gotchas.

## Explicit non-goals (from spec)

`vendo init` BYO mode; standalone `@vendoai/ai-sdk`/`@vendoai/mastra` packages; other frameworks; MCP-door changes.
