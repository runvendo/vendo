# Execution v2 Machine Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. This plan is deliberately high-level (owner preference): each lane states goals, boundaries, and gates; workers derive their own task breakdowns and test-first steps inside their lane.

**Goal:** Implement the three-layer machine model from
`docs/superpowers/specs/2026-07-19-execution-v2-design.md`: per-app sandbox
machines with the skin-of-the-box contract, an in-box coding agent, Cloud
broker/sandbox/gateway defaults with BYO paths, and experimental layer 3.

**Architecture:** Tree apps unchanged. Graduated apps gain a persistent
fast-wake sandbox whose only contract is its boundary (env in, `POST /fn/<name>`
out, `vendo.json` schedules). A Claude Agent SDK harness inside the box builds
and edits server code. Host's Vendo server proxies fn calls, hosts the callback
surface (store rows + guarded host tools), and gates layer 3 behind an
experimental flag.

**Tech stack:** TypeScript monorepo (`@vendoai/*`), e2b SDK, Claude Agent SDK,
existing StoreAdapter/SecretsProvider/ToolRegistry seams, Vendo Cloud console
(vendo-web repo) for broker + hosted sandbox + gateway tokens.

**Orchestration:** Fleet pattern from the v2 format build: one worker per lane
in its own worktree, workers self-triage AI reviewers and merge on green
`pnpm build && pnpm test && pnpm typecheck && pnpm lint`; orchestrator
coordinates waves, resolves cross-lane seams, and runs the live verification
gates. Cloud-side work coordinates with the active cloud-backend session in the
vendo-web Orca workspace before any change there. Live e2b/Anthropic spend
authorized (judgment; destroy sandboxes after use). UI-affecting changes need
real-browser screenshots in the PR.

**Planning-level calls (orchestrator-owned, recorded here):**
- SandboxAdapter v2 seam shrinks to: create-from-template, resume, request
  (HTTP proxy to $PORT), snapshot, stop, destroy. Outside-the-box exec/files
  drop out of the public seam (the in-box agent replaced them); a diagnostic
  exec may remain adapter-internal.
- Wake/sleep: wake on demand (fn call, schedule, edit prompt), auto-sleep via
  snapshot after an idle timeout (default 5 minutes, provider-side where
  supported). No always-on machines in v2.
- `fn:` wire syntax is agreed with the format lane before Wave 2 merges; until
  then Wave 1 exposes fn calls only through the proxy route.

---

## Wave 1 — Foundations (three parallel lanes)

### Lane A: Sandbox seam v2 + e2b adapter
Rewrite the SandboxAdapter seam to the shrunk shape; implement the e2b adapter
against it for real (template-based create, snapshot pause/resume, proxied
requests); delete the dead v1 adapter code paths (Modal adapter goes; it can
return later behind the same seam). Conformance suite runs on a fake adapter in
CI and on live e2b behind an env-gated lane.
**Gate:** live e2b round-trip: create → serve hello app → request → snapshot →
resume → request → destroy.

### Lane B: Machine lifecycle in @vendoai/apps
App documents gain a machine reference (provider-prefixed snapshot/template
ref). Lifecycle: provision on graduation, wake on demand, sleep on idle,
destroy with the app. Fork/export rules: machine refs never export; a forked
app gets no machine until it re-graduates.
**Gate:** unit + fake-adapter integration for the full lifecycle.

### Lane C: Skin contract on the host server
Env assembly at wake (PORT, injected secrets, store URL + app token, host
callback URL + token, inference endpoint/key). `vendo.json` schema +
validation. Proxy route: authenticated host-server endpoint forwarding to the
machine's `POST /fn/<name>`. Callback surface: app-token-authenticated HTTP API
for durable rows (store-backed) and host tool invocation through the guard
(approvals and audit intact).
**Gate:** fake-adapter e2e: tree action → proxy → fn → callback writes a row →
host tool call routes through guard.

## Wave 2 — Wiring (two lanes, after Wave 1)

### Lane D: fn bindings + scheduler paths
`fn:` refs in v2 tree queries/actions (syntax agreed with format lane),
resolved through the proxy. Schedule execution: BYO path first (an endpoint the
host or any external cron hits; it wakes due machines and posts their fn
targets), broker-shaped so Cloud can call the same surface.
**Gate:** generalization-matrix-style check: a tree app with one fn binding
renders and round-trips on both demo hosts.

### Lane E: Secrets + egress allowlist
Grant-style domain allowlist per app: declared in `vendo.json`, approved once
by the user/host, enforced at the sandbox network layer (e2b network policy);
secrets env-injection wired end-to-end from SecretsProvider/Cloud vault.
**Gate:** live e2b: allowlisted domain reachable, non-allowlisted blocked,
secret present in env and never in the document or store.

## Wave 3 — The agent in the box (single lane, after Wave 2)

Base snapshot template: Node + Claude Agent SDK harness + bootstrap process.
Edit flow: host sends prompt + context to the box; the agent writes code,
installs deps, runs the server, curls its own fn endpoints, iterates until
green, snapshots, reports a structured result. Graduation 1→2: the tree
pipeline's agent decides a request needs a machine, provisions one, delegates
server work to the box agent, and lands `fn:` bindings in the tree via the
normal edit dialect. Inference: gateway token default, BYO key env fallback.
**Gate (the invoice-chaser demo, live):** from a prompt on demo-bank, a tree
app graduates to layer 2, its schedule fires via the cron endpoint, the fn does
allowlisted egress, writes durable rows, and the tree shows the result.
Browser screenshots required.

## Wave 4 — Layer 3, experimental (single lane, after Wave 3)

Serving: non-`/fn/` paths on the machine are the app surface; host embeds it
(iframe surface component) with theming handoff. Experimental flag: per-project
opt-in on the host config; disabled = layer 3 generation and serving both
refuse cleanly. 2→3 flow: agent rebuilds the UI as a web app in the same box;
the tree keeps serving until the new surface passes its own checks, then the
surface flips. Generation is real end-to-end this time.
**Gate:** live: a layer-3 app generated, served from e2b, embedded in
demo-bank, interactive in a real browser, screenshots in the PR; flag off =
cleanly refused.

## Wave 5 — Cloud (parallel with Waves 3-4 where possible)

In vendo-web (coordinate with the active cloud-backend session there first;
divide or hand off overlapping pieces): hosted sandbox service behind the
SandboxAdapter seam, scheduler broker calling the same schedule surface as BYO
cron, scoped metered gateway tokens for box inference. OSS side: Cloud adapters
selected by `VENDO_API_KEY` default-slot rule only (adapter rule; no hidden
branches).
**Gate:** zero-key-beyond-VENDO_API_KEY path: graduation, schedule fire, and
box inference all through Cloud on a demo host.

## Wave 6 — Docs + close-out

`docs/` updates (persistence-and-deploy, quickstart, new machine-model page),
docs-site sync, memory update, final full-gate run on main, backlog notes for
deferred items (Modal adapter return, wake/sleep economics tuning, layer-3
hardening list).

---

## Self-review checklist (run before execution)

- Spec coverage: every spec section maps to a lane (layers 1-3, skin, agent,
  scheduler, data rule, secrets/egress, experimental gate, graduation, Cloud).
- No placeholder lanes: each lane has a concrete gate a worker can run.
- Seam consistency: Lanes A/C/D/E all build against the Wave-1 seam shapes;
  fn: syntax is the only cross-repo coordination point and is explicitly gated.
