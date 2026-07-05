# Vendo PRD

> Synced snapshot of the [Notion PRD](https://app.notion.com/p/PRD-391efc48a641803c94b8d95930e5ebd7) (2026-07-01). **Notion is the source of truth** — if this file and Notion disagree, Notion wins; re-sync this file when the PRD changes.

**One-Liner:** A devtool that lets your users customize your product.

- One-click dev tool + running on the company's existing API and auth.
- Allows the user to customize your product in your own brand.

## Core Features

- **One-click dev tool**
  - Run one command on the host codebase → extracts (1) themes/styles, (2) reusable components, (3) the API/CLI/SDK surface the agent can act through
  - Never changes existing code, can add code
  - Output feeds everything below: theming, component registry, tool discovery
- **Agent acts through the company's existing API, as the user**
  - Authenticated with the user's own credentials → we sit on their existing security layer, not beside it
  - Per-user auth threading, not a shared service principal
- **UI generation**
  - Any arbitrary UI: agent writes real component code, runs in the locked sandbox (egress-jailed, opaque origin, governed actions)
  - Stays on-brand: meshes generated code with the company's own components + extracted theme
  - One output path: everything AI-generated renders in the sandbox
- **Safeguards + permissions**
  - Danger-gated actions → approval cards. Bank-grade: the agent can be authenticated to do something and still not allowed to.
- **Fast generation**
  - Quick first response + live skeletons while the UI streams in
- **Integrations via Composio**
- **Automations**
  - Describe it in plain English → compiles into the right kind of automation, on a schedule or trigger (time, host events, integration/MCP events)
  - Two execution tiers, one authoring surface:
    - Deterministic: trigger → fixed steps. Predictable, cheap, auditable, no LLM per firing. Most "when X do Y" rules land here.
    - Agentic: a full agent run with a goal + tools → judgment, variable inputs; can do anything the agent does in chat (host API, integrations, generate/update UIs, notify)
  - Hybrid allowed: deterministic backbone with agent steps where judgment is needed; agents can call workflows as tools
  - Runs server-side with the user's auth, even when they're not in the app
  - Manageable + inspectable: see what it compiled to, list, edit, pause, run history
- **AI memory** → user actions + account history, injected by relevance
- **Company grounding** → agent grounded in company docs, cites, doesn't hallucinate, resists hijacking
- **Save what you make**
  - Generated UIs/dashboards persist, reopenable, part of the product

## What runs where?

- **Local → their app / their infra:**
  - Shell surfaces (page, overlay, droppable slots) + chat UI → SDK in their frontend
  - Sandbox → runs in the end-user's browser, egress-jailed; generated code never leaves the device at render time
  - Theme tokens + component registry → build artifacts in their repo
  - Host-API actions → run against their API with the user's own credentials, inside their existing security perimeter
  - One-click dev tool → dev-time CLI on their codebase; extracts locally, then a build-time `vendo publish` uploads a reviewable tool manifest (versioned + hash-keyed) to the Vendo registry — sessions bind to a published manifest
- **Vendo cloud → ours:**
  - Agent runtime (LLM loop, tool-calling, policy evaluation). Their backend vouches for user identity, we run the loop. **BYOK later** so companies bring their own model key; the runtime stays ours.
  - Automations engine → fires when the user isn't in the app; their auth brokered server-side
  - Memory + saved-vendo store → cross-device, shareable, survives sessions
  - Concierge SMS channel + realtime voice relay
  - Enterprise layer (later) → governance, audit, analytics, cost metering
- **Third-party regardless:** Composio (integration OAuth + tool execution), model provider

## UX

- Agent center page in the dashboard/sidebar: chat + your created/pinned UIs
- Droppable components the company places anywhere → tap, create UI in place
- Realtime voice mode: talk to it, it does/shows things live. No dictation stepping stone.
- Concierge text channel: reach the agent off-product (SMS/chat), same tools + permissions

## Enterprise readiness (later, after core)

- Admin governance console → what the agent may ever do, per tenant (tools, codegen on/off, approval routing)
- Audit log + compliance → every action recorded, PII posture
- Observability + cost → adoption analytics, token spend caps, latency SLOs
