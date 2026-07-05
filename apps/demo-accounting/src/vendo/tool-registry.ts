/**
 * Static, synchronous tool-descriptor resolution for the consent endpoint
 * (ENG-193 §4.5 ruling (c): "resolve the LIVE descriptor from the engine's
 * registered toolset"). The engine itself only assembles a toolset inside a
 * `run()` closure (no standalone lookup exists) — but every tool this demo
 * ever gates is one of three known, statically-describable sources, so this
 * resolver rebuilds descriptors the SAME way `buildDescriptor` would without
 * needing a live model turn or a Composio network round-trip:
 *
 * - Cadence's own host tools: real annotations already computed by
 *   `openApiToHostTools` from the OpenAPI spec (host-tools.ts) — exact.
 * - Automation-authoring tools: their tool objects carry `annotations`
 *   directly (`createAutomationTools`, `destructiveHint: true` for
 *   create/update/delete) — `buildDescriptor` reads that straight off the
 *   object — exact.
 * - Composio-ingested tools (GMAIL_* / GOOGLECALENDAR_*): this app never
 *   attaches real MCP annotations to these (confirmed: `policy.ts`'s
 *   `namePolicy` decides them by verb-segment matching, not by descriptor).
 *   `buildDescriptor` with no explicit annotations therefore correctly
 *   resolves them to tier "act" + unverified (Yousef's own ruling for
 *   unknown-annotation tools) — this is accurate, not a workaround.
 *
 * GRANT HASH PARITY with the live engine descriptors (ENG-193 review
 * 2026-07-04): `hashDescriptor` covers the projection {name, source,
 * annotations, executor} only, so a grant minted from THIS resolver's
 * descriptor must agree with the live one on exactly those fields:
 * - Host tools: the same `hostToolset(cadenceHostToolDefs)` objects feed both
 *   sides (annotations from OpenAPI, `vendoExecutor: "client"`) — exact.
 * - Authoring tools: the same live tool objects are introspected — exact.
 * - Composio: verified against `@composio/vercel@0.4.0`'s source — its
 *   wrapper builds bare ai-SDK `tool({description, inputSchema, execute})`
 *   objects with NO `annotations` and no `_meta`, so live ingestion's
 *   `buildDescriptor(name, tool, "composio")` also lands on
 *   `annotations: {}` + executor "server", matching this resolver's
 *   `buildDescriptor(name, {}, "composio")`. The fields that DO differ live
 *   (`hasExecute: true`, possibly a different `kind`) are excluded from the
 *   hash by design — see tool-registry.test.ts's round-trip test.
 */
import { buildDescriptor, hostToolset, type ToolDescriptor } from "@vendoai/runtime";
import { cadenceHostToolDefs } from "./host-tools";
import { automationsWorld } from "./automations";

const hostTools = hostToolset(cadenceHostToolDefs);

export function resolveToolDescriptor(toolName: string): ToolDescriptor | undefined {
  const host = hostTools[toolName];
  if (host) return buildDescriptor(toolName, host, "caller");

  const authoring = automationsWorld().authoringTools()[toolName];
  // ENG-193 PR #40 review (item A): source "control" — authoring tools are
  // Vendo's own control-plane tools, judge/breaker-exempt at the live
  // engine (agent.ts's `controlTools`); this resolver must agree (see this
  // module's "GRANT HASH PARITY" note above).
  if (authoring) return buildDescriptor(toolName, authoring, "control");

  // Composio-ingested tools: no static tool object exists to introspect (the
  // real schema is fetched per-principal at chat time), but the ANNOTATIONS
  // are always empty in this app regardless — so building a descriptor with
  // no explicit annotations produces the same tier/unverified result the live
  // one would.
  if (/^[A-Z]+_[A-Z_]+$/.test(toolName)) {
    return buildDescriptor(toolName, {}, "composio");
  }
  return undefined;
}
