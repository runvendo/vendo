/**
 * All Flowlet endpoints (chat, action, integrations, capabilities, tick) —
 * served by `createFlowletHandler()` from @flowlet/next, wired to Maple's
 * demo modules. This replaces the hand-rolled chat/action/integrations
 * routes and is the proof the handler covers a real host's needs:
 *
 *  - the agent cache keys on the demo connection store + automations-world
 *    generation (`cacheKey`), so connecting a toolkit or resetting the demo
 *    rebuilds the agent exactly as before;
 *  - `connections` injects the demo store, so /api/flowlet/reset still clears
 *    connection state;
 *  - the demo's own automations world flows in through `tools` (handler
 *    automations stay off);
 *  - the local-only guard keeps FLOWLET_DEMO_PUBLIC=1 as the deploy opt-in.
 *
 * The sibling static routes (poll, reset) remain demo-custom and win over
 * this catch-all in Next routing.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { createFlowletHandler, type ConnectionsStore } from "@flowlet/next";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export const { GET, POST } = createFlowletHandler({
  model: anthropic(process.env.FLOWLET_DEMO_MODEL ?? "claude-sonnet-4-6"),
  // Per-run function (spec §7): grounds capability talk in the live toolset.
  instructions: (ctx) => buildInstructions({ toolSummary: ctx.toolSummary }),
  policy: demoPolicy,
  tools: () => ({ ...demoTools(), ...automationsWorld().authoringTools() }),
  components: mapleHostComponents,
  hostTools: mapleHostToolDefs,
  connections: demoConnections,
  principal: (req) => (principalAllowed(req) ? DEMO_PRINCIPAL : null),
  cacheKey: () => String(automationsGeneration()),
  automations: false,
});
