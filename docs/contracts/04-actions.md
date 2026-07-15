# @vendoai/actions — your API becomes agent tools

Status: FROZEN (wave-2 gate passed by Yousef, 2026-07-11). Changes now require a major. One job: own ALL tools. Host API, external connectors (Composio, any MCP server), and Vendo capability tools are one tool shape — same risk labels, same guard treatment, same approval UX. Executes as the signed-in user when present; through the host's `actAs` when away. Depends on core only.

Two halves: sync (a build step) and runtime.

## 1. Sync — extraction as a build step, never a command

"Sync is a build step → tools can't go stale." `vendo init` is the visible, interactive first pass (09 §5); after that, sync runs inside build/dev-start. Missing `.vendo/` → full extract; skipping init never breaks.

```ts
export function vendoSync(options: {
  root: string;                          // host app root
  out?: string;                          // default ".vendo"
  strict?: boolean;                      // breaking change → non-zero exit (CI gating); default fail-soft warn
}): Promise<SyncReport>;

export interface SyncReport {
  tools: { added: string[]; removed: string[]; changed: string[] };
  breaking: BreakingChange[];
  pins: { captured: string[]; drifted: string[] };   // remixable component baselines (06 §8)
  catalog: { discovered: number; registered: number }; // additive @1 amendment approved by Yousef, 2026-07-14
}

export interface BreakingChange {
  tool: string;
  change: "removed" | "input-narrowed" | "renamed";
}
// Blast radius ("which saved apps reference this tool") is a runtime query over vendo_apps, not a build-step concern.
```

Launch extraction tier: **OpenAPI + route-scan** (corpus-proven). tRPC/GraphQL/server actions next — new extractors change no format below. Extraction is fail-closed: a route the scanner can't classify is emitted `disabled: true` with a note, never silently auto-allowed.

### `.vendo/tools.json` (generated, host-committed)

```jsonc
{
  "format": "vendo/tools@1",
  "tools": [
    {
      // ToolDescriptor fields (core §4) ...
      "name": "host_invoices_list",
      "description": "List invoices",
      "inputSchema": { /* JSON Schema */ },
      "risk": "read",
      // plus the execution binding:
      "binding": { "kind": "route", "method": "GET", "path": "/api/invoices", "argsIn": "query" }
      // | { "kind": "openapi", "operationId": "listInvoices", "baseUrl": "..." }
    }
  ]
}
```

### Component catalog extraction — additive within @1 (approved 2026-07-14)

Sync also owns `.vendo/catalog.json`. It is a deterministic, machine-generated, host-committed
review artifact: every sync regenerates it, and a missing `.vendo/` at build
causes the same regeneration. Init asks no catalog questions and prints exactly
`catalog.json: N discovered, M registered` after its silent sync.

The TypeScript compiler API is the inventory and props-schema source of truth;
regex extraction and model-authored inventory are forbidden. A component is
discoverable only with exported-map registration evidence from a
`<VendoRoot components={...}>` JSX use, a callable JSX implementation, a stable
module/export path, and a representable props type. Unrepresentable exotic prop
types produce a permissive schema plus a tool-authored explanatory `note`, or
the entry is omitted. Statically serializable `createVendo({ catalog })` code
registrations are merged by name and win over scanned entries.

```jsonc
{
  "format": "vendo/catalog@1",
  "entries": [{
    "name": "InvoiceCard",
    "exportPath": "./src/vendo/host-components.tsx#hostComponents.InvoiceCard",
    "propsSchema": { "type": "object", "properties": {} },
    "description": "Use when reviewing one invoice.",
    "examples": ["<InvoiceCard invoice={invoice} />"],
    "source": "registered", // or "scanned"
    "disabled": false,
    "note": "optional tool-authored explanation"
  }]
}
```

The catalog and every entry use strict Zod validation so stale or misspelled
fields fail sync loudly. Rescans replace all deterministic fields and all
tool-owned fields; only previously accepted `description`/`examples` on a
still-scanned entry persist, keeping unchanged reruns byte-identical. The LLM
may propose only `description`/`examples`, written as before/after records in
`.vendo/catalog.proposals.json`; runtime never reads that artifact, and catalog
copy changes only through an explicit acceptance operation. Registered copy
lives in code and is regenerated from code on every sync.

`disabled` remains in the strict `catalog@1` entry schema for forward
conformance, but is reserved for the extraction-M5 curation workflow and the
install-DX correction-path design. Until that human-owned persistence exists,
sync does not preserve hand-authored disabled flags and runtime does not filter
catalog entries by this field; do not use it as a curation control.

Known runtime limit: `propsSchema` from disk is JSON Schema prompt guidance,
not an executable validator. Disk-loaded entries use a pass-through
`StandardSchema` at runtime, while explicit code registrations retain their
real `StandardSchema` validators. Strong runtime prop validation therefore
requires code registration until a JSON-Schema validation seam is added.

### `.vendo/overrides.json` (human-written, respected forever)

Re-extraction never touches it; answers from the init interview land here.

```jsonc
{
  "format": "vendo/overrides@1",
  "tools": {
    "host_invoices_delete": { "risk": "destructive", "critical": true },
    "host_internal_debug": { "disabled": true },
    "host_invoices_send": { "description": "Send an invoice email to the customer" }
  }
}
```

Merge rule: descriptor = extracted ∪ overrides, overrides win field-wise; `descriptorHash` is computed post-merge (an override that changes risk lapses old grants — correct and intended).

## 2. Runtime

```ts
import type { ToolRegistry, ToolCall, ToolDescriptor, RunContext, ActAs, ToolOutcome } from "@vendoai/core";

export function createActions(config: {
  dir?: string;                          // read .vendo/{tools,overrides}.json; or:
  tools?: ExtractedTool[];               // inject directly (tests, non-file hosts); ExtractedTool = ToolDescriptor & { binding: RouteBinding | OpenApiBinding }
  connectors?: Connector[];
  actAs?: ActAs;                         // host seam; absent → away execution cleanly unavailable
  baseUrl?: string;                      // host origin for server-side route execution
  fetch?: typeof fetch;
}): ActionsRegistry;

export interface ActionsRegistry extends ToolRegistry {
  /** Register Vendo capability tools (apps hands its create/edit tools in via the umbrella). */
  add(tools: ToolRegistry): void;
}
```

## 3. Connectors — lean, we build zero

```ts
export interface Connector { name: string; descriptors(): Promise<ToolDescriptor[]>; execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome>; }

export function composioConnector(config: { apiKey: string; entityId?: (ctx: RunContext) => string; apps?: string[] }): Connector;
export function mcpConnector(config: { url: string; headers?: Record<string, string>; name?: string }): Connector;
```

Normalization rules: connector tool names are underscore-prefixed inside the provider-safe charset (core §4): `gmail_send`, `mcp_<server>_<tool>` (truncated + suffix-hashed past 64 chars); risk labels come from connector annotations when present, else default **`write`** (conservative), overridable in `overrides.json`; MCP tools are re-described through the same descriptor shape so guard sees no difference.

## 4. Execution semantics (normative)

- **Present** (`presence: "present"`): the call rides the user's real session. Server-side route execution forwards the inbound request's auth material (`ctx.requestHeaders` — cookies/authorization captured by the umbrella handler) on a same-origin fetch to `binding.path`. Zero config.
- **Away** (`presence: "away"`): requires a captured grant (the only authority) and the host's `actAs(principal, grant)` → `AuthMaterial` attached to the request. `actAs` not implemented → `ToolOutcome{status:"error", code:"not-implemented"}` with agent-readable messaging ("away execution isn't set up for this product") — features degrade cleanly, no stack detection, no adapter framework.
- Connector calls use the connector's own auth (Composio entity, MCP session) but identical guard treatment.
- actions itself never checks policy: it executes what a guard binding lets through (05 §2). It stamps nothing on the audit trail directly; the binding does.

## 5. Principals

OSS: `kind: "user"` only. Org principals (org-wide automations, admin actions, org-shared connections) are Cloud; the shapes already accommodate them via `Principal.kind` and change nothing here.
