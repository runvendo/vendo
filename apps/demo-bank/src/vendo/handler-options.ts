/**
 * The single `createVendoHandler()` options object — split out of route.ts
 * so `instrumentation.ts` can pass the SAME object reference to
 * `startVendoScheduler()`. Per `packages/vendo-server/src/fetch-handler.ts`'s
 * BootRegistry doc: the route and the scheduler boot hook must share one
 * assembled world, or the scheduler ends up ticking a DIFFERENT (private,
 * default) world than the one serving HTTP requests — any `automations.tools`
 * the route registers would silently be invisible to firings the internal
 * scheduler drives. Demo-bank customizes `model`/`policy`/`tools`/`automations`
 * etc., so (unlike a pure zero-config install) it must wire this explicitly.
 */
import { anthropic } from "@ai-sdk/anthropic";
import type { VendoHandlerOptions, ConnectionsStore } from "vendo/server";
import type { VendoPrincipal, RegisteredTool, ToolDescriptor } from "@vendoai/runtime";
import { buildInstructions } from "@/vendo/agent";
import { demoPolicy } from "@/vendo/policy";
import { demoTools } from "@/vendo/tools";
import { automationsWorld, automationsGeneration } from "@/vendo/automations";
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

/**
 * Persistence-drill flag (scripts/drill-persistence.mjs — see
 * docs/superpowers/plans/2026-07-04-automations-oss-persistence.md Task 19).
 * OFF by default: the demo keeps its normal shape (its own bespoke in-memory
 * automations world for chat authoring, `DEMO_PRINCIPAL`). Set VENDO_DRILL=1
 * to turn on the HANDLER's built-in automations world instead (so the drill
 * can exercise DrizzleAutomationStore, the boot scheduler, and grants — none
 * of which the demo's bespoke world goes through) and align the request
 * principal with that world's fixed scope (tenantId "vendo-embedded",
 * subject "vendo-default-user" — see packages/vendo-server/src/guard.ts's
 * WORLD_SCOPE) so the drill's seeded threads/vendos are visible through the
 * same identity the automations world runs as.
 */
const DRILL_MODE = process.env.VENDO_DRILL === "1";

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

const DRILL_PRINCIPAL: VendoPrincipal = { userId: "vendo-default-user" };

/** One shared object — same reference every time this module is imported
 *  (ES modules are singletons), passed verbatim to both `createVendoHandler`
 *  (route.ts) and `startVendoScheduler` (instrumentation.ts). */
export const vendoOptions: VendoHandlerOptions = {
  // Belt-and-suspenders alongside the shared-object fast path above: Next.js
  // compiles instrumentation.ts and route.ts into separate module graphs, so
  // this module can be evaluated twice, producing two `!==` objects with
  // identical shape — bootKey gives the boot registry a stable identity that
  // survives that split (see fetch-handler.ts's BootRegistry comment).
  bootKey: "demo-bank",
  model: anthropic(process.env.VENDO_DEMO_MODEL ?? "claude-sonnet-4-6"),
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
