# @vendoai/actions — your API becomes agent tools

Status: DRAFT (wave 2). One job: own ALL tools. Host API, external connectors (Composio, any MCP server), and Vendo capability tools are one tool shape — same risk labels, same guard treatment, same approval UX. Executes as the signed-in user when present; through the host's `actAs` when away. Depends on core only.

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
}

export interface BreakingChange {
  tool: string;
  change: "removed" | "input-narrowed" | "renamed";
  /** Blast radius: which saved apps/automations reference this tool (requires a store; empty without one). */
  affects: Array<{ installId: InstallId; appName: string }>;
}
```

Launch extraction tier: **OpenAPI + route-scan** (corpus-proven). tRPC/GraphQL/server actions next — new extractors change no format below. Extraction is fail-closed: a route the scanner can't classify is emitted `disabled: true` with a note, never silently auto-allowed.

### `.vendo/tools.json` (generated, host-committed)

```jsonc
{
  "format": "vendo/tools@1",
  "tools": [
    {
      // ToolDescriptor fields (core §4) ...
      "name": "host.invoices.list",
      "description": "List invoices",
      "input": { /* JSON Schema */ },
      "risk": "read",
      "source": "host",
      // plus the execution binding:
      "binding": { "kind": "route", "method": "GET", "path": "/api/invoices", "argsIn": "query" }
      // | { "kind": "openapi", "operationId": "listInvoices", "baseUrl": "..." }
    }
  ]
}
```

### `.vendo/overrides.json` (human-written, respected forever)

Re-extraction never touches it; answers from the init interview land here.

```jsonc
{
  "format": "vendo/overrides@1",
  "tools": {
    "host.invoices.delete": { "risk": "destructive", "critical": true },
    "host.internal.debug": { "disabled": true },
    "host.invoices.send": { "description": "Send an invoice email to the customer" }
  }
}
```

Merge rule: descriptor = extracted ∪ overrides, overrides win field-wise; `descriptorHash` is computed post-merge (an override that changes risk lapses old grants — correct and intended).

## 2. Runtime

```ts
import type { ToolSet, ToolCall, ToolDescriptor, RunContext, ActAs, ToolOutcome, InstallId } from "@vendoai/core";

export function createActions(config: {
  dir?: string;                          // read .vendo/{tools,overrides}.json; or:
  tools?: ExtractedTool[];               // inject directly (tests, non-file hosts); ExtractedTool = ToolDescriptor & { binding: RouteBinding | OpenApiBinding }
  connectors?: Connector[];
  actAs?: ActAs;                         // host seam; absent → away execution cleanly unavailable
  baseUrl?: string;                      // host origin for server-side route execution
  fetch?: typeof fetch;
}): ActionsRegistry;

export interface ActionsRegistry extends ToolSet {
  /** Register Vendo capability tools (apps hands its create/edit tools in via the umbrella). */
  add(tools: ToolSet): void;
}
```

## 3. Connectors — lean, we build zero

```ts
export interface Connector { name: string; descriptors(): Promise<ToolDescriptor[]>; execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome>; }

export function composioConnector(config: { apiKey: string; entityId?: (ctx: RunContext) => string; apps?: string[] }): Connector;
export function mcpConnector(config: { url: string; headers?: Record<string, string>; name?: string }): Connector;
```

Normalization rules: connector tool names are prefixed (`gmail.send`, `mcp.<server>.<tool>`); risk labels come from connector annotations when present, else default **`write`** (conservative), overridable in `overrides.json`; MCP tools are re-described through the same descriptor shape so guard sees no difference.

## 4. Execution semantics (normative)

- **Present** (`presence: "present"`): the call rides the user's real session. Server-side route execution forwards the inbound request's auth material (`ctx.requestHeaders` — cookies/authorization captured by the umbrella handler) on a same-origin fetch to `binding.path`. Zero config.
- **Away** (`presence: "away"`): requires a captured grant (the only authority) and the host's `actAs(principal, grant)` → `AuthMaterial` attached to the request. `actAs` not implemented → `ToolOutcome{status:"error", code:"not-implemented"}` with agent-readable messaging ("away execution isn't set up for this product") — features degrade cleanly, no stack detection, no adapter framework.
- Connector calls use the connector's own auth (Composio entity, MCP session) but identical guard treatment.
- actions itself never checks policy: it executes what a guard binding lets through (05 §2). It stamps nothing on the audit trail directly; the binding does.

## 5. Principals

OSS: `kind: "user"` only. Org principals (org-wide automations, admin actions, org-shared connections) are Cloud; the shapes already accommodate them via `Principal.kind` and change nothing here.
