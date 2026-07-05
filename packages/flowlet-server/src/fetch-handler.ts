/**
 * `createFlowletFetchHandler()` — the framework-agnostic Web Fetch API
 * handler behind every Flowlet framework adapter (`@flowlet/next` today).
 * Point any router at it — a Next.js catch-all, an Express/Hono bridge,
 * a raw `Bun.serve` — and it serves everything Flowlet needs from one place.
 *
 * Endpoints (relative to the route's mount, keyed on the LAST path segment
 * so any mount prefix works):
 *   POST /chat          — streamed agent turn (host tools via the caller seam)
 *   POST /action        — sandbox dispatch through the policy (+ approval tokens)
 *   GET|POST /integrations — Composio connect flow (inert without the key)
 *   GET  /capabilities  — { chat, integrations, voice, mcp } from env-key/config presence
 *   GET  /deliveries    — in-app Channels feed for FlowletToasts (single-tenant)
 *   POST /tick          — drives the automations scheduler
 *   POST /resume        — resumes a paused automation run (approval toast)
 *   anything else       — 404 JSON error
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
import type { InstructionContext } from "@flowlet/runtime";
import { createSourceResolver } from "./remix-enrich";
import { resolveRemixSealer } from "./seal";
import { createAutomationsWorld, type FlowletAutomationsWorld } from "./world";
import { resolveModel } from "./model";
import { defaultFlowletPolicy } from "./default-policy";
import { resolvePrincipal, DEFAULT_PRINCIPAL } from "./guard";
import { parseHandlerOptions, type FlowletHandlerOptions } from "./options";

/** The path segment after the mount the handler was invoked with. */
function subPath(req: Request): string {
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

export type FlowletFetchHandler = (req: Request) => Promise<Response>;

export function createFlowletFetchHandler(rawOptions: FlowletHandlerOptions = {}): FlowletFetchHandler {
  const options = parseHandlerOptions(rawOptions);

  // Everything below is built lazily on first request: framework adapters
  // (e.g. `next build`) import route modules at build time, and reading
  // `.flowlet/` or requiring keys there would break builds in clean CI
  // environments. `assemble` is async because provider resolution loads
  // optional peer packages via dynamic import; the memoized promise keeps
  // the lazy-on-first-request behavior.
  let assembled: ReturnType<typeof assemble> | null = null;
  async function assemble() {
    const loaded = loadFlowletDir(options.flowletDir);
    // MCP servers: the code option OVERRIDES the file entirely; ${ENV_VAR}
    // header substitution applies only to file-sourced entries (code already
    // runs in an env-aware context). A server whose var is missing is dropped
    // with a warning. The capability flag reads the RESOLVED list.
    const mcpServers = options.mcpServers ?? resolveMcpServers(loaded.mcpServers ?? []);
    const capabilities = {
      ...detectCapabilities(undefined, { hasInjectedModel: options.model !== undefined }),
      mcp: mcpServers.length > 0,
    };
    const hostTools = options.hostTools ?? manifestToolsToHostTools(loaded.manifest.tools);
    const model = options.model ?? (await resolveModel());
    const policy = options.policy ?? defaultFlowletPolicy;
    const catalog = options.integrations ?? DEFAULT_INTEGRATION_CATALOG;
    const connections = options.connections ?? createConnectionsStore(catalog);

    // SINGLE-TENANT (see world.ts): one embedded scope for the store, the
    // deliveries feed, and approval resumes.
    const worldScope = { tenantId: "flowlet-embedded", subject: DEFAULT_PRINCIPAL.userId };
    const world: FlowletAutomationsWorld | null =
      options.automations === false
        ? null
        : createAutomationsWorld({
            policy,
            model,
            ...(options.automations?.tools ? { tools: options.automations.tools } : {}),
            scope: worldScope,
          });

    const serverTools = (): ToolSet => {
      const extra = typeof options.tools === "function" ? options.tools() : options.tools ?? {};
      return { ...extra, ...(world ? world.authoringTools() : {}) };
    };

    // Default prompt is a per-run FUNCTION (spec §1/§7): the capability
    // summary needs the live merged toolset, which only exists after tool
    // ingestion inside the engine's run().
    const instructions =
      options.instructions ??
      ((ctx: InstructionContext) =>
        buildInstructions({
          productName: options.productName ?? "this app",
          brand: loaded.brand,
          components: options.components ?? [],
          hostToolNames: hostTools.map((t) => t.name),
          integrations: capabilities.integrations ? catalog : [],
          automations: world !== null,
          toolSummary: ctx.toolSummary,
          ...(options.instructionsExtra ? { extra: options.instructionsExtra } : {}),
        }));

    // Remix-source enrichment: option first, then flowlet sync's capture
    // (re-read from disk in dev; see remix-enrich.ts).
    const resolveRemixSource = createSourceResolver({
      ...(options.remixSources ? { option: options.remixSources } : {}),
      captured: loaded.remixSources,
    });

    // Pin-envelope sealing (remix fast-edits). No key material → pin editing
    // degrades to the anchor baseline; everything else is unaffected.
    const remixSealer = resolveRemixSealer({
      sealSecret: options.sealSecret,
      hasInjectedModel: options.model !== undefined,
    });

    const getAgent = createAgentCache({
      model,
      policy,
      instructions,
      ...(loaded.envManifest ? { envManifest: loaded.envManifest } : {}),
      // The engine's render_view registry must know the prewired catalog too —
      // host-node validation rejects any name it can't find (ENG-186).
      components: [...prewiredComponents, ...(options.components ?? [])],
      tools: serverTools,
      ...(capabilities.integrations ? { toolkits: () => connections.connectedToolkits() } : {}),
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
      ...(options.cacheKey ? { cacheKey: options.cacheKey } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(remixSealer ? { remixSealer } : {}),
    });

    return {
      capabilities,
      hostTools,
      policy,
      connections,
      world,
      worldScope,
      serverTools,
      getAgent,
      resolveRemixSource,
      remixSealer,
      approvals: createApprovalStore(),
    };
  }
  // Memoize the assembly promise, but drop it on rejection so the next
  // request retries fresh (the old sync code threw before assignment, so a
  // boot failure — bad FLOWLET_MODEL, missing peer — was never cached). The
  // identity check keeps a late rejection from clobbering a newer assembly.
  const state = () => {
    if (!assembled) {
      const p = assemble();
      p.catch(() => {
        if (assembled === p) assembled = null;
      });
      assembled = p;
    }
    return assembled;
  };

  /** A boot (assembly) failure surfaces as a 500, not an unhandled rejection. */
  function bootError(err: unknown): Response {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  async function GET(req: Request, s: Awaited<ReturnType<typeof assemble>>): Promise<Response> {
    switch (subPath(req)) {
      case "capabilities":
        return Response.json(s.capabilities);
      case "integrations":
        return handleIntegrationsGet(req, {
          store: s.connections,
          enabled: s.capabilities.integrations,
          options,
        });
      case "deliveries": {
        // FlowletToasts polls this: in-app Channels deliveries since a cursor.
        if (!s.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        // SINGLE-TENANT world (see world.ts): the feed belongs to the world's
        // fixed subject. Under a custom multi-user principal resolver, other
        // subjects must NOT read it — fail closed rather than leak run
        // summaries across users (Codex review, 2026-07-04).
        if (guard.principal.userId !== s.worldScope.subject) {
          return Response.json(
            { error: "automation deliveries are single-tenant; front your own world for multi-user installs" },
            { status: 403 },
          );
        }
        const raw = Number(new URL(req.url).searchParams.get("since") ?? "0");
        const since = Number.isFinite(raw) && raw >= 0 ? raw : 0;
        return Response.json({ deliveries: s.world.channels.listSince(s.worldScope, since) });
      }
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  async function POST(req: Request, s: Awaited<ReturnType<typeof assemble>>): Promise<Response> {
    switch (subPath(req)) {
      case "chat":
        return handleChat(req, {
          getAgent: s.getAgent,
          hostTools: s.hostTools,
          options,
          resolveRemixSource: s.resolveRemixSource,
          ...(s.remixSealer ? { remixSealer: s.remixSealer } : {}),
          // capabilities.chat is the single source of truth: it already
          // folds in an injected model (via hasInjectedModel above) alongside
          // any configured provider key.
          chatEnabled: s.capabilities.chat,
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
      case "resume": {
        // Approval toast → resume the paused run. Unknown/already-settled runs
        // answer `stale` (the toast flips to its stale state) instead of 500.
        if (!s.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        // Same single-tenant fail-closed rule as /deliveries: only the world's
        // subject may resume its paused runs.
        if (guard.principal.userId !== s.worldScope.subject) {
          return Response.json(
            { error: "automation resume is single-tenant; front your own world for multi-user installs" },
            { status: 403 },
          );
        }
        const body = (await req.json().catch(() => ({}))) as {
          runId?: unknown;
          approved?: unknown;
          stepId?: unknown;
        };
        if (typeof body.runId !== "string" || body.runId.length === 0) {
          return Response.json({ error: "runId is required" }, { status: 400 });
        }
        const run = await s.world.runner.resume(
          s.worldScope,
          body.runId,
          body.approved === true,
          typeof body.stepId === "string" ? body.stepId : undefined,
        );
        if (!run) return Response.json({ stale: true });
        return Response.json({
          run: { id: run.id, status: run.status, outcome: run.outcome ?? null },
        });
      }
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  return async function flowletFetchHandler(req: Request): Promise<Response> {
    let s: Awaited<ReturnType<typeof assemble>>;
    try {
      s = await state();
    } catch (err) {
      return bootError(err);
    }
    switch (req.method) {
      case "GET":
        return GET(req, s);
      case "POST":
        return POST(req, s);
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  };
}
