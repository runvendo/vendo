# Flowlet Platform Architecture

**Date:** 2026-07-01
**Status:** Approved (brainstormed with Yousef)
**Scope:** North-star architecture for the whole PRD. Each Flowlet Platform epic (ENG-197, 198, 200, 202, 184, 188, 189, 183, 185, 191, 194) implements against the seams defined here.
**Sources:** Notion PRD (rewritten 2026-07-01), Flowlet Platform Linear project, existing monorepo (F1 to F5 demo phase).

## Summary

Flowlet is built as one portable agent runtime with five injected seams, deployed two ways: Flowlet cloud (the product) and embedded in a host backend (an architectural guarantee, kept honest by demo-bank in CI). Interactive host-API tool calls execute in the user's browser on their existing session. Automations execute server-side under a brokered, short-lived grant. The one-click dev tool emits three artifacts into the host repo; the tool manifest is published to a cloud registry at build time.

## Decisions

### 1. Portable runtime, two deployments

`@flowlet/runtime` (evolving `flowlet-agent`) is a library containing the agent loop: LLM engine, tool calling, policy, UI generation. It never imports a database, queue, or HTTP server. It depends only on five seams:

| Seam | Purpose | Embedded impl | Cloud impl |
|---|---|---|---|
| Store | threads, saved flowlets, memory, automations, audit | host's choice (in-memory/SQLite in CI) | our Postgres |
| CredentialBroker | how a tool call gets user identity | host session, in-process | vouch JWT + token exchange |
| Executor | where a tool call physically runs | in-process | client executor / server executor |
| Scheduler | firing automations when the user is away | none or host cron | pg-boss worker |
| Channels | in-app, SMS, voice transports | in-app only | in-app now; SMS/voice later |

- **Cloud** (`apps/cloud`) is the product: multi-tenant, hosts automations, cross-device store, channels, enterprise layer later.
- **Embedded** (runtime inside the host's own backend) is an architectural guarantee only: not documented or sold yet. demo-bank runs the runtime in-process, so any cloud concern leaking into the runtime breaks CI. Embedded is BYOK by definition, which keeps the PRD's "BYOK later" cheap.

### 2. Topology: client-executed host-API tools

The SDK in the host frontend streams directly to Flowlet cloud (SSE, ai SDK UIMessage protocol, as in F1). The loop runs in cloud. When the agent calls a host-API tool interactively:

- The tool call streams down to the SDK, which executes fetch against the host API from the user's browser with their existing session (ai SDK client-tool mechanism: onToolCall, addToolResult).
- User credentials never transit Flowlet cloud. We see only tool results.
- Composio and other integration tools execute cloud-side as today.
- Automations (user absent) use the server executor with a brokered grant (Decision 4).

A host-backend server executor can be added later as an opt-in for enterprises that want everything in-perimeter.

### 3. Dev-tool artifact contract

`npx flowlet init` scans the host codebase and emits three artifacts into `.flowlet/` in their repo. It never modifies existing code.

1. `theme.json`: extracted design tokens. Consumed by the sandbox theme injection (exists, F3a).
2. `components/`: descriptor + wrapper pairs around the host's own components, compiled into the sandbox bundle. Consumed by the registry and renderer (exist, F1/F3b).
3. `tools.json`: the host API surface (OpenAPI, tRPC, GraphQL, route scan) as tool descriptors with mutating/dangerous annotations, developer-editable. Consumed by the runtime for tool discovery (new, ENG-202). Also declares host event types available as automation triggers.

Delivery is **build-time publish**: `flowlet publish` (locally or CI) uploads the manifest to the cloud registry, keyed by tenant, version, and hash. Sessions bind to a published manifest at init. This gives a central, reviewable tool surface from day 1. Consequences accepted:

- The PRD line "extracts, uploads nothing" is revised to "extracts locally; publishes a reviewable manifest."
- Embedded mode reads `.flowlet/` from disk; publish is a no-op there.
- Manifest rows are immutable; a re-publish is a new row. Enterprise approval/diff (ENG-194) becomes a review queue over data we already have.

### 4. Identity and auth

Three credentials, three lifetimes:

1. **Vouch JWT (who is this user):** the host backend adds one endpoint that signs a short-lived JWT (tenant, subject, claims) with a key registered at tenant setup (JWKS or pasted key). The SDK presents it at session init; cloud verifies and issues its own session token. The dev tool can generate this endpoint per framework.
2. **Interactive host-API calls:** no credential shared at all. The browser executes them on the user's existing session (Decision 2).
3. **Brokered grant (automations):** the host backend exposes a token-exchange endpoint (RFC 8693 shape). The worker presents a signed assertion (tenant, subject, automation id, scopes) and receives a short-lived scoped user token, held only for the run. Revocation lives on the host side. Only required when a tenant enables automations, so day-1 integration is just the vouch endpoint.

The existing policy layer (F2) evaluates every tool call regardless of executor. Danger-gated actions emit approval cards interactively; automations either pre-authorize scopes at creation or pause for async approval.

### 5. Automations (high level; detail deferred)

Locked now:

- **Two execution tiers, one authoring surface.** Plain English in chat; a compiler agent emits an inspectable spec the user can read, edit, and pause. Hybrid allowed: deterministic backbone with agent-step nodes.
- **Deterministic tier is an interpreted JSON step graph**, not generated code. Inspectable by construction, can only call registered tools, policy applies per step, no LLM per firing. No server-side codegen sandbox.
- **Three trigger sources:** cloud scheduler (time), signed webhooks from the host backend (event types declared in the manifest), Composio triggers.
- **Execution** in the cloud worker under the brokered grant, with run history.

Deliberately open, to be brainstormed at ENG-188 time: storage shape, DSL field design and expression language, spec versioning, run retention.

### 6. Data layer

One Postgres in `apps/cloud`, all access behind the Store seam. Jobs via pg-boss (Postgres-backed queue; no Redis, one database to operate). Core concerns:

- `tenants`, `users`: tenant = host app (keys, Composio ref, settings); users are vouched subjects, unique per (tenant, subject). No PII beyond the vouch claims.
- `manifests`: immutable published rows with an active pointer per environment.
- `threads`, `messages`: persisted UIMessage streams (replaces the demo's in-memory route state).
- `saved_flowlets` (ENG-183): declarative UI tree + bound data query + originating prompt + name/pin. Reopening re-renders the tree and re-runs the query through the normal tool path.
- `automations`, `automation_runs`: shape deferred (Decision 5).
- `audit_events`: append-only record of every tool execution, approval, grant exchange, and firing. Written from day 1; ENG-194 becomes UI over it.
- **Memory (ENG-189): deliberately undefined.** The architecture reserves a Store concern and a context-assembly injection point in the runtime, and assumes memories may be ingested from outside the chat loop (host analytics such as PostHog, account history, events). Schema, write/read policy, and sources are decided when that work starts.

### 7. Package layout

```
packages/
  flowlet-core        contracts (exists)
  flowlet-runtime     NEW: portable loop + five seams (evolves flowlet-agent)
  flowlet-stage       sandbox (exists)
  flowlet-components  pre-wired library (exists)
  flowlet-shell       surfaces (exists)
  flowlet-react       SDK (exists)
  flowlet-cli         NEW: init, publish, dev
apps/
  cloud               NEW: API service (SSE, sessions, manifest registry, approvals)
                      + worker (scheduler, webhook ingest, automation execution)
                      Two entrypoints of one deployable; split only when scale forces it.
  demo-bank           stays: embedded-mode CI guarantee + e2e host
```

Stack: Node/TS, Postgres, pg-boss, Railway initially. Anthropic-first via the ai SDK, provider-agnostic as today.

## Sequencing

Dependency-ordered:

1. Land in-flight work: ENG-200 (one-box UI gen), then ENG-201 cleanup.
2. **Contracts freeze** (short): manifest schema + the five seam interfaces. Unlocks the parallel tracks.
3. Parallel tracks:
   - **A. Cloud skeleton (ENG-198):** runtime carve-out, session init/vouch, SSE chat, manifest registry, worker skeleton. The linchpin; other tracks merge onto it.
   - **B. Dev tool (ENG-197):** extractor first (theme, then tools.json, then component wrapping, in order of extraction difficulty). Needs only the schema; longest-tail work, so it starts earliest. `publish` lands when A's registry exists.
   - **C. Host-API tools (ENG-202):** descriptors + client executor, built and proven in embedded demo-bank (no cloud needed), then ported onto A's cloud session.
   - **D. Automations front half (ENG-188):** DSL spec, interpreter, compiler agent as pure library code with in-memory scheduler in tests. Back half (webhook ingest, token exchange, pg-boss) waits on A. Preceded by its own brainstorm (Decision 5).
   - **E. Brand-native quality (ENG-184):** continuous and independent; never blocks, never blocked.
4. Then: ENG-183 saved flowlets on the Store; ENG-189 memory (own brainstorm first).
5. Later: ENG-185 voice and ENG-191 SMS on the Channels seam; ENG-194 enterprise (audit log already accumulating).

## Follow-ups

- Revise the PRD's "uploads nothing" line to match Decision 3.
- Sync these decisions into the Linear epics (ENG-197, 198, 202, 188 descriptions).
- ENG-188 and ENG-189 each get their own brainstorm before implementation.
