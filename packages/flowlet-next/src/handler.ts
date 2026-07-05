/**
 * `createFlowletHandler()` — the one-call Next.js (App Router) adapter.
 *
 * Wire it in a catch-all route and everything demo-bank hand-rolls is served
 * from one place:
 *
 *   // app/api/flowlet/[...path]/route.ts
 *   import { createFlowletHandler } from "@flowlet/next";
 *   export const runtime = "nodejs";
 *   export const dynamic = "force-dynamic";
 *   export const { GET, POST } = createFlowletHandler();
 *
 * Endpoints (relative to the catch-all mount):
 *   POST /chat          — streamed agent turn (host tools via the caller seam)
 *   POST /action        — sandbox dispatch through the policy (+ approval tokens)
 *   GET|POST /integrations — Composio connect flow (inert without the key)
 *   GET  /capabilities  — { chat, integrations, voice } from env-key presence
 *   POST /tick          — drives the automations scheduler
 *
 * ZERO-CONFIG: with no options it reads `.env` (capability-additive keys) and
 * `.flowlet/` (theme, tools manifest) and just works — ANTHROPIC_API_KEY alone
 * gives working chat + generated UI.
 */
import type { ToolSet } from "ai";
import { prewiredComponents } from "@flowlet/components/descriptors";
import { handleChat } from "./chat";
import { handleAction, createApprovalStore } from "./action";
import {
  DEFAULT_INTEGRATION_CATALOG,
  createConnectionsStore,
  handleIntegrationsGet,
  handleIntegrationsPost,
} from "./integrations";
import { detectCapabilities } from "./capabilities";
import { loadFlowletDir } from "./flowlet-dir";
import { resolveMcpServers } from "./mcp-config";
import { manifestToolsToHostTools } from "./manifest-tools";
import { buildInstructions, createAgentCache } from "./agent";
import { createAutomationsWorld, defaultModel, type FlowletAutomationsWorld } from "./world";
import { defaultFlowletPolicy } from "./default-policy";
import { resolvePrincipal, DEFAULT_PRINCIPAL } from "./guard";
import { parseHandlerOptions, type FlowletHandlerOptions } from "./options";

export interface FlowletRouteHandlers {
  GET: (req: Request) => Promise<Response>;
  POST: (req: Request) => Promise<Response>;
}

/** The path segment after `/api/flowlet/` the catch-all was invoked with. */
function subPath(req: Request): string {
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

export function createFlowletHandler(rawOptions: FlowletHandlerOptions = {}): FlowletRouteHandlers {
  const options = parseHandlerOptions(rawOptions);

  // Everything below is built lazily on first request: `next build` imports
  // route modules at build time, and reading `.flowlet/` or requiring keys
  // there would break builds in clean CI environments.
  let assembled: ReturnType<typeof assemble> | null = null;
  function assemble() {
    const loaded = loadFlowletDir(options.flowletDir);
    // MCP servers: the code option OVERRIDES the file entirely; ${ENV_VAR}
    // header substitution applies only to file-sourced entries (code already
    // runs in an env-aware context). A server whose var is missing is dropped
    // with a warning. The capability flag reads the RESOLVED list.
    const mcpServers = options.mcpServers ?? resolveMcpServers(loaded.mcpServers ?? []);
    const capabilities = { ...detectCapabilities(), mcp: mcpServers.length > 0 };
    const hostTools = options.hostTools ?? manifestToolsToHostTools(loaded.manifest.tools);
    const model = options.model ?? defaultModel();
    const policy = options.policy ?? defaultFlowletPolicy;
    const catalog = options.integrations ?? DEFAULT_INTEGRATION_CATALOG;
    const connections = options.connections ?? createConnectionsStore(catalog);

    const world: FlowletAutomationsWorld | null =
      options.automations === false
        ? null
        : createAutomationsWorld({
            policy,
            model,
            ...(options.automations?.tools ? { tools: options.automations.tools } : {}),
            scope: { tenantId: "flowlet-embedded", subject: DEFAULT_PRINCIPAL.userId },
          });

    const serverTools = (): ToolSet => {
      const extra = typeof options.tools === "function" ? options.tools() : options.tools ?? {};
      return { ...extra, ...(world ? world.authoringTools() : {}) };
    };

    const instructions =
      options.instructions ??
      buildInstructions({
        productName: options.productName ?? "this app",
        brand: loaded.brand,
        components: options.components ?? [],
        hostToolNames: hostTools.map((t) => t.name),
        integrations: capabilities.integrations ? catalog : [],
        automations: world !== null,
        ...(options.instructionsExtra ? { extra: options.instructionsExtra } : {}),
      });

    const getAgent = createAgentCache({
      model,
      policy,
      instructions,
      // The engine's render_view registry must know the prewired catalog too —
      // host-node validation rejects any name it can't find (ENG-186).
      components: [...prewiredComponents, ...(options.components ?? [])],
      tools: serverTools,
      ...(capabilities.integrations ? { toolkits: () => connections.connectedToolkits() } : {}),
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
      ...(options.cacheKey ? { cacheKey: options.cacheKey } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    });

    return {
      capabilities,
      hostTools,
      policy,
      connections,
      world,
      serverTools,
      getAgent,
      approvals: createApprovalStore(),
    };
  }
  const state = () => (assembled ??= assemble());

  async function GET(req: Request): Promise<Response> {
    const s = state();
    switch (subPath(req)) {
      case "capabilities":
        return Response.json(s.capabilities);
      case "integrations":
        return handleIntegrationsGet(req, {
          store: s.connections,
          enabled: s.capabilities.integrations,
          options,
        });
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  async function POST(req: Request): Promise<Response> {
    const s = state();
    switch (subPath(req)) {
      case "chat":
        return handleChat(req, {
          getAgent: s.getAgent,
          hostTools: s.hostTools,
          options,
          // A host that injects its own `model` owns the key; otherwise chat
          // needs ANTHROPIC_API_KEY (capabilities.chat).
          chatEnabled: options.model !== undefined || s.capabilities.chat,
        });
      case "action":
        return handleAction(req, {
          getTools: s.serverTools,
          policy: s.policy,
          approvals: s.approvals,
          options,
        });
      case "integrations":
        return handleIntegrationsPost(req, {
          store: s.connections,
          enabled: s.capabilities.integrations,
          options,
        });
      case "tick": {
        if (!s.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        await s.world.tick();
        return Response.json({ ok: true });
      }
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  return { GET, POST };
}
