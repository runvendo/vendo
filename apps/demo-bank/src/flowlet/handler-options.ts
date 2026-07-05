/**
 * The single `createFlowletHandler()` options object — split out of route.ts
 * so `instrumentation.ts` can pass the SAME object reference to
 * `startFlowletScheduler()`. Per `packages/flowlet-next/src/handler.ts`'s
 * BootRegistry doc: the route and the scheduler boot hook must share one
 * assembled world, or the scheduler ends up ticking a DIFFERENT (private,
 * default) world than the one serving HTTP requests — any `automations.tools`
 * the route registers would silently be invisible to firings the internal
 * scheduler drives. Demo-bank customizes `model`/`policy`/`tools`/`automations`
 * etc., so (unlike a pure zero-config install) it must wire this explicitly.
 */
import { anthropic } from "@ai-sdk/anthropic";
import type { FlowletHandlerOptions, ConnectionsStore } from "@flowlet/next";
import type { FlowletPrincipal, RegisteredTool, ToolDescriptor } from "@flowlet/runtime";
import { buildInstructions } from "@/flowlet/agent";
import { demoPolicy } from "@/flowlet/policy";
import { demoTools } from "@/flowlet/tools";
import { automationsWorld, automationsGeneration } from "@/flowlet/automations";
import {
  listIntegrations,
  connect,
  disconnect,
  connectedToolkits,
  setConnectedAccount,
  findByConnectedAccount,
} from "@/flowlet/connections-store";
import { mapleHostToolDefs } from "@/flowlet/host-tools";
import { mapleHostComponents } from "@/flowlet/host-components/descriptors";
import { DEMO_PRINCIPAL } from "@/flowlet/principal";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** Only expose the real Composio identity to local requests, unless an
 *  operator explicitly opted a deployment in via FLOWLET_DEMO_PUBLIC=1. */
function principalAllowed(req: Request): boolean {
  if (process.env.FLOWLET_DEMO_PUBLIC === "1") return true;
  const host = req.headers.get("host");
  let hostname = host ? (host.split(":")[0] ?? "") : "";
  if (!hostname) {
    try {
      hostname = new URL(req.url).hostname;
    } catch {
      hostname = "";
    }
  }
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

/** The demo connection store, adapted to the handler's seam. */
const demoConnections: ConnectionsStore = {
  list: listIntegrations,
  connect,
  disconnect,
  connectedToolkits,
  setConnectedAccount,
  findByConnectedAccount,
};

/**
 * Persistence-drill flag (scripts/drill-persistence.mjs — see
 * docs/superpowers/plans/2026-07-04-automations-oss-persistence.md Task 19).
 * OFF by default: the demo keeps its normal shape (its own bespoke in-memory
 * automations world for chat authoring, `DEMO_PRINCIPAL`). Set FLOWLET_DRILL=1
 * to turn on the HANDLER's built-in automations world instead (so the drill
 * can exercise DrizzleAutomationStore, the boot scheduler, and grants — none
 * of which the demo's bespoke world goes through) and align the request
 * principal with that world's fixed scope (tenantId "flowlet-embedded",
 * subject "flowlet-default-user" — see packages/flowlet-next/src/guard.ts's
 * WORLD_SCOPE) so the drill's seeded threads/flowlets are visible through the
 * same identity the automations world runs as.
 */
const DRILL_MODE = process.env.FLOWLET_DRILL === "1";

/** MUST byte-for-byte match scripts/drill-persistence.constants.mjs's copy:
 *  computeGrant hashes over this object, and a mismatched descriptor makes
 *  the seeded grant invalid (the step would pause for approval instead of
 *  running unattended). */
const DRILL_ECHO_DESCRIPTOR: ToolDescriptor = {
  name: "drill_echo",
  source: "caller",
  annotations: {},
  hasExecute: true,
  kind: "function",
};

const drillTools: Record<string, RegisteredTool> = {
  drill_echo: {
    descriptor: DRILL_ECHO_DESCRIPTOR,
    execute: async () => ({ ok: true, result: { ok: true } }),
  },
};

const DRILL_PRINCIPAL: FlowletPrincipal = { userId: "flowlet-default-user" };

/** One shared object — same reference every time this module is imported
 *  (ES modules are singletons), passed verbatim to both `createFlowletHandler`
 *  (route.ts) and `startFlowletScheduler` (instrumentation.ts). */
export const flowletOptions: FlowletHandlerOptions = {
  model: anthropic(process.env.FLOWLET_DEMO_MODEL ?? "claude-sonnet-4-6"),
  // Per-run function (spec §7): grounds capability talk in the live toolset.
  instructions: (ctx) => buildInstructions({ toolSummary: ctx.toolSummary }),
  policy: demoPolicy,
  tools: () => ({ ...demoTools(), ...automationsWorld().authoringTools() }),
  components: mapleHostComponents,
  hostTools: mapleHostToolDefs,
  connections: demoConnections,
  principal: (req) => (principalAllowed(req) ? (DRILL_MODE ? DRILL_PRINCIPAL : DEMO_PRINCIPAL) : null),
  cacheKey: () => String(automationsGeneration()),
  automations: DRILL_MODE ? { tools: drillTools } : false,
};
