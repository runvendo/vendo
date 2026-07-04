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
 */
import { buildDescriptor, hostToolset, type ToolDescriptor } from "@flowlet/runtime";
import { cadenceHostToolDefs } from "./host-tools";
import { automationsWorld } from "./automations";

const hostTools = hostToolset(cadenceHostToolDefs);

export function resolveToolDescriptor(toolName: string): ToolDescriptor | undefined {
  const host = hostTools[toolName];
  if (host) return buildDescriptor(toolName, host, "caller");

  const authoring = automationsWorld().authoringTools()[toolName];
  if (authoring) return buildDescriptor(toolName, authoring, "engine");

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
