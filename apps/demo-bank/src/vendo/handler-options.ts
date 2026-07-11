/**
 * The single `createVendoHandler()` options object — split out of route.ts
 * for the demo-bank host.
 */
import { anthropic } from "@ai-sdk/anthropic";
import type { VendoHandlerOptions, ConnectionsStore } from "vendoai/server";
import { buildInstructions } from "@/vendo/agent";
import { demoPolicy } from "@/vendo/policy";
import { demoTools } from "@/vendo/tools";
import {
  listIntegrations,
  connect,
  disconnect,
  connectedToolkits,
  setConnectedAccount,
  findByConnectedAccount,
} from "@/vendo/connections-store";
import { mapleHostToolDefs } from "@/vendo/host-tools";
import { mapleHostComponents } from "@/vendo/host-components/descriptors";
import { DEMO_PRINCIPAL } from "@/vendo/principal";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** Only expose the real Composio identity to local requests, unless an
 *  operator explicitly opted a deployment in via VENDO_DEMO_PUBLIC=1. */
function principalAllowed(req: Request): boolean {
  if (process.env.VENDO_DEMO_PUBLIC === "1") return true;
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

/** One shared object — same reference every time this module is imported. */
export const vendoOptions: VendoHandlerOptions = {
  // Belt-and-suspenders alongside the shared-object fast path above: Next.js
  // compiles instrumentation.ts and route.ts into separate module graphs, so
  // this module can be evaluated twice, producing two `!==` objects with
  // identical shape — bootKey gives the boot registry a stable identity that
  // survives that split (see fetch-handler.ts's BootRegistry comment).
  bootKey: "demo-bank",
  // Only inject a model when a real credential exists — `detectCapabilities`
  // treats ANY injected model as chat-capable (`hasInjectedModel`), so an
  // unconditional inject would make a keyless boot report chat:true and then
  // 500 on the first turn. This exists purely to pin the demo's model id;
  // it must never be the thing that turns chat on.
  ...(process.env.ANTHROPIC_API_KEY
    ? { model: anthropic(process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6") }
    : {}),
  // Per-run function (spec §7): grounds capability talk in the live toolset.
  instructions: (ctx) => buildInstructions({ toolSummary: ctx.toolSummary }),
  policy: demoPolicy,
  tools: demoTools,
  components: mapleHostComponents,
  hostTools: mapleHostToolDefs,
  connections: demoConnections,
  principal: (req) => (principalAllowed(req) ? DEMO_PRINCIPAL : null),
  automations: false,
};
