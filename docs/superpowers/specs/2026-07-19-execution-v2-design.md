# Execution v2: the machine model

Status: approved by Yousef 2026-07-19 (this brainstorm). Decision record for the
execution-v2 lane. Supersedes the v1 ladder in `docs/archive/contracts/06-apps.md`
(rungs 1-4, fn: tiers, fork/swap graduation).

## Summary

Three layers. One new noun (the machine). One contract (the skin of the box).
The coding agent lives inside the box.

1. **Tree app**: no server. The v2 tree document, rendered by the host-embedded
   renderer, interactive via `$state`, code islands, and guarded host tools.
   Generated and edited by the fast tree pipeline. Most apps stay here.
2. **Tree app + machine**: same tree UI, plus a persistent per-app sandbox where
   execution lives: schedules, third-party egress with secrets, heavy logic,
   working data. The machine never draws UI.
3. **Machine everything**: the machine also serves a real web app; the host
   embeds its URL as the app surface. The tree is gone. Experimental in v2:
   ships fully built but disabled unless the project enables it.

The agent escalates layers when the request demands it; the user never picks.

## What died (and why)

- **Rung 2 vs rung 3 as separate tiers**: collapsed. There is no server-computed
  tree and no server-owned UI shaping. The tree owns interactivity ($state,
  islands, actions + re-query); the machine owns execution only.
- **Patch-from-machine channel**: rejected as overcomplication. When a
  machine-backed app needs new UI, the answer is the same as for tree apps: the
  agent edits the app.
- **Fork/swap/snapshot graduation machinery**: stays dead (kill-list verdict
  upheld). Graduation 1->2 is additive in place; 2->3 swaps the surface only
  after the new one is live.
- **Required server-side runtime kit**: rejected. The machine contract is
  language-neutral HTTP + env vars, not a Vendo framework. An optional Node
  convenience SDK may exist as sugar, never as a requirement.

## The machine

A persistent per-app sandbox. Sleeps as a snapshot, wakes in about a second
when poked. Vendo Cloud hosted sandbox is the zero-config default; BYO e2b key
is the OSS escape hatch behind the same adapter seam (adapter rule from the
Cloud definition applies unchanged).

Graduation reasons (all four confirmed real): scheduled/background work,
third-party egress with secrets, heavy custom logic, app-owned working state.
None of them are UI reasons. That is why the machine never draws.

## The skin of the box (the whole contract)

Inside the box is free country: any language, any framework, any process.
Vendo owns only the boundary:

**In (environment):**
- `PORT`: where the app listens
- injected secrets (from host SecretsProvider / Cloud vault)
- store URL + app token: durable rows over plain HTTP, curl-able from any language
- host callback URL + app token: host tool calls, routed through the host's
  Vendo server where the guard lives (approvals, audit, acting-as-the-user);
  the box never holds raw authority over host data
- inference endpoint + token (see agent section)

**Out (HTTP on `$PORT`):**
- `POST /fn/<name>`: tree-callable functions and schedule targets
- anything else served is the layer-3 web app (layer 2 vs 3 is not a mode,
  just which paths the app serves)

**Manifest (`vendo.json`):**
- schedule declarations ("at 0 8 * * *, POST /fn/chaseInvoices"), read by the
  broker. Declarative, no runtime library required.

## Scheduler

The Vendo Cloud broker fires schedules for sleeping machines (fits the
infra-half of Cloud). BYO path: any external cron (Vercel cron, GitHub
Actions, crontab) hitting an endpoint on the host's Vendo server.

## Data rule

Anything that needs to persist goes through the Vendo store (host StoreAdapter
or Cloud hosted store). The VM disk is scratch, caches, and working files;
snapshots are not a database. Scaffold and agent guidance make the store client
the obvious path.

## Secrets and egress

Keys live in Vendo secrets and are env-injected at wake. Each app declares the
domains it talks to; the user/host approves them once (grant-style); sandbox
egress is restricted to that allowlist at the network layer. This is the SSRF
and exfil answer, including for the BYO-model-key case below.

## The agent lives in the box

Every machine's base snapshot includes a Claude Code-type coding agent.
"Edit this app" sends a prompt to the box; the agent writes code, installs
deps, runs the server, curls its own endpoints, fixes failures, reports done.
Self-verification against reality replaces schema-constrained one-shot
generation for server code.

Why inside: building a server app is a minutes-long loop, and the host's Vendo
server (often serverless Next.js) cannot babysit it; the box is the one
long-running computer in the system. Outside-the-box orchestration and
per-command proxying disappear.

Inference: Vendo Cloud's Anthropic-compatible gateway with a scoped metered
token by default; BYO model key as env var otherwise. Accepted trade-off: on
the BYO path the host's model key sits inside a box running generated code;
the egress allowlist is the mitigation.

Layer-1 tree generation never touches a box. The tier-0/tier-2 tree pipeline
is unchanged.

## Layer 3 (experimental)

Fully built in v2: generation, serving, embedding, edit loop, verified in a
real browser on a real sandbox (no repeat of v1's designed-but-fake rung 4).
Gated: disabled by default, enabled per project by the host. A served app is a
guest, not a native: brand via theming rather than host components; host-API
access rides the same callback seam as layer 2.

## Graduation mechanics

- **1 -> 2**: invisible and additive. Provision machine, land functions, tree
  grows `fn:` bindings. The tree keeps working throughout.
- **2 -> 3**: an honest UI rewrite in the same box. The tree keeps serving
  until the new surface is live, then the surface flips.

## Dependencies and inherited punts

- **Hosted store backend**: layer-2 data rule leans on it for Cloud-default
  installs (one-pager PR #355 pending). BYO StoreAdapter path works regardless.
- **Pins / drift / rebase**: unchanged by this spec; owned by the format lane
  scope (pins kept per the 2026-07-17 re-derivation decisions).
- **SSRF / egress stack**: resolved here via the allowlist decision.

## Open questions (deliberately deferred to planning)

- Exact SandboxAdapter v2 seam shape (what survives of create/resume/request/
  exec/files/snapshot given the agent moved inside the box).
- Machine wake/sleep policy and idle timeout economics.
- The in-box agent's harness choice and base-snapshot update story.
- fn: binding syntax in the v2 wire format (format lane coordination).

## Appendix: shipped-state deviations and backlog (2026-07-20, Wave 6 close-out)

Deviations from this record as built, plus the known backlog. One line each.

- In-box agent is a thin custom loop (box harness `agent-loop.mjs` against the
  inference door), not the Claude Agent SDK; revisit when the SDK runs well
  headless in a box.
- e2b adapter never extends the provider TTL on activity; mitigated by the
  `VENDO_E2B_TIMEOUT_MS` knob and the edit-budget-implied lifetime, root-cause
  fix (extend-on-activity) still owed.
- e2b snapshot refs whose provider state was reaped externally surface as wake
  errors; not-found eviction (clear the stale ref, re-provision) still owed.
- fn-binding tree edits occasionally emit `/data/`-style envelope paths the
  validator rejects; graduation retries contain it, dialect-level fix owed.
- Served-app iframes do not keep the machine awake; no keepalive ping or
  TTL extend-on-activity, so a long-lived open tab can hit an idle sleep.
- PGlite store has no atomic CAS capability on `vendo_apps`, so lifecycle and
  schedule claims degrade to read-then-put on the dev store (multi-process
  dev hosts can double-fire; Postgres is unaffected).
- Cloud artifact storage meters 0 GB for now (console-side caveat, no wire
  impact); snapshot storage becomes billable later.
- Cloud served-app ingress TLS for `*.m.vendo.run` is broken in prod (one-label
  Universal SSL); needs an advanced certificate before Cloud layer-3 URLs work.
- Modal adapter stays deferred; it can return behind the same SandboxAdapter
  seam.
- A secret grant or egress change while a machine is awake does not restart
  the app with new env in place; it lands via the env re-injection push at the
  next edit or the policy re-check at the next wake, an in-place restart loop
  is still owed.
