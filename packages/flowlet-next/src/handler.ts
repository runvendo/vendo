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
 *   POST /consent       — answers a ConsentRequest; server-validates grant
 *                          creation (ENG-193)
 *   POST /fade-proposal — resolves a fade proposal (ENG-193 §4.4)
 *   GET  /grants        — Trust screen: federated grants (standing + automation) (ENG-193 §3 Moment 12)
 *   POST /grants/revoke — Trust screen: revoke a standing grant (ENG-193 §3 Moment 12)
 *   GET  /audit         — Trust screen: audit query (ENG-193 §3 Moment 12)
 *   GET  /critical-tools — Trust screen: tools that always need the human (ENG-193 §3 Moment 12)
 *   POST /tick          — drives the automations scheduler
 *
 * ZERO-CONFIG: with no options it reads `.env` (capability-additive keys) and
 * `.flowlet/` (theme, tools manifest) and just works — ANTHROPIC_API_KEY alone
 * gives working chat + generated UI.
 */
import type { ToolSet } from "ai";
import { prewiredComponents } from "@flowlet/components/descriptors";
import {
  buildDescriptor,
  createBreakerState,
  createFadeTracker,
  createInMemoryGrantStore,
  hostToolset,
  InMemoryAuditLog,
  InMemoryThreadStore,
} from "@flowlet/runtime";
import { handleChat } from "./chat";
import { handleAction, createApprovalStore } from "./action";
import { handleConsentRoute } from "./consent";
import { handleFadeProposalRoute } from "./fade-proposal";
import { listParkedActionsRoute, resolveParkedActionRoute } from "./parked-actions";
import { listGrantsRoute, revokeGrantRoute, queryAuditRoute, listCriticalToolsRoute } from "./trust";
import {
  DEFAULT_INTEGRATION_CATALOG,
  createConnectionsStore,
  handleIntegrationsGet,
  handleIntegrationsPost,
} from "./integrations";
import { detectCapabilities } from "./capabilities";
import { loadFlowletDir } from "./flowlet-dir";
import { manifestToolsToHostTools } from "./manifest-tools";
import { buildInstructions, createAgentCache } from "./agent";
import { createAutomationsWorld, defaultModel, type FlowletAutomationsWorld } from "./world";
import { defaultFlowletPolicy } from "./default-policy";
import { composeProductionPolicy, EMBEDDED_TENANT } from "./policy-stack";
import { createThreadIndex } from "./threads";
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
    const capabilities = detectCapabilities();
    const loaded = loadFlowletDir(options.flowletDir);
    const hostTools = options.hostTools ?? manifestToolsToHostTools(loaded.manifest.tools);
    const model = options.model ?? defaultModel();
    const grants = options.store?.grants ?? createInMemoryGrantStore();
    const audit = options.store?.audit ?? new InMemoryAuditLog();
    const threads = options.store?.threads ?? new InMemoryThreadStore(() => new Date().toISOString());
    const threadIndex = createThreadIndex(threads);
    const breakers = options.store?.breakers ?? createBreakerState();
    const fadeTracker = options.store?.fadeTracker ?? createFadeTracker();
    // ENG-193 item 2/3: the production stack wraps the host's base policy —
    // grants can suppress repeat approvals (never critical), a judge (off by
    // default) can tighten/loosen the act tier, deterministic breakers can
    // only tighten, and audit records executes.
    const basePolicy = options.policy ?? defaultFlowletPolicy;
    const policy = composeProductionPolicy(basePolicy, { grants, audit, judgeModel: options.judgeModel, breakers });
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
            // ENG-193 §4.6/§6.2: parked-action resolutions get the SAME
            // "consent" audit trail chat approvals already do.
            audit,
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
      ...(options.cacheKey ? { cacheKey: options.cacheKey } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      // ENG-193 §6.2: persist each SETTLED run's full message list to the
      // thread store. This is the single writer for thread messages (chat.ts
      // deliberately does NOT persist the request body) — the streamed
      // assistant turn, with any approval-requested parts, must be in the
      // store BEFORE the client's consent POST arrives, which happens before
      // any next chat turn. The engine hands back the same threadId chat.ts
      // resolved and passed into run(), so the fixed hook can attribute each
      // settled list to the right thread.
      //
      // Continuation turns (host-tool resumes, approval resumes) REVISE the
      // trailing assistant message in place — ai's onFinish returns
      // `[...originalMessages.slice(0, -1), state.message]`, the SAME length
      // as what a previous settle stored — so an append-only prefix delta
      // silently drops the revision (live-verification bug, 2026-07-04: the
      // approval-requested part never reached the store and consent 404'd).
      // `ThreadStore.replaceMessages` (optional seam member, additive like
      // `Store.grants`) persists the full settled list; stores without it
      // fall back to the old prefix delta, which is correct for append-only
      // turns and best-effort for continuations.
      // ENG-193 review follow-up (queued gap): the Trust diary's audit
      // read never saw client-executed host-tool calls (no server execute
      // for the normal onExecuted hook to observe) — the engine now audits
      // them itself from the run's incoming history. Same EMBEDDED_TENANT
      // scoping every other audit write on this mount already uses
      // (policy-stack.ts's `principalScope`).
      audit,
      auditPrincipal: (p) => ({ tenantId: EMBEDDED_TENANT, subject: p.userId }),
      onSettled: async ({ messages, threadId, principal }) => {
        const scope = { tenantId: EMBEDDED_TENANT, subject: principal.userId };
        // Skip runs whose threadId isn't a store-assigned thread (a direct
        // getAgent().run caller with no resolved thread) — the writes below
        // throw on unknown ids and the engine would just log the noise.
        if (!(await threads.get(scope, threadId))) return;
        if (threads.replaceMessages) {
          await threads.replaceMessages(scope, threadId, messages);
          return;
        }
        const existing = await threads.getMessages(scope, threadId);
        const toAppend = messages.slice(existing.length);
        if (toAppend.length > 0) {
          await threads.appendMessages(scope, threadId, toAppend);
        }
      },
    });

    // Static tool-descriptor resolver for the consent endpoint (ENG-193 §4.5
    // ruling (c): "resolve the LIVE descriptor from the engine's registered
    // toolset"). Exact for host tools and server tools whose objects carry
    // annotations; act+unverified for Composio names, which carry no
    // annotations on this path. Even if a live Composio descriptor ever
    // differed, `grantPolicy` re-checks the LIVE tier before suppressing, so
    // a mis-minted grant can never fire on a critical tool — item-1 invariant.
    const clientTools = hostToolset(hostTools);
    const resolveDescriptor = (toolName: string) => {
      const client = clientTools[toolName];
      if (client) return buildDescriptor(toolName, client, "caller");
      const server = serverTools()[toolName];
      if (server) return buildDescriptor(toolName, server, "engine");
      if (/^[A-Z]+_[A-Z_]+$/.test(toolName)) return buildDescriptor(toolName, {}, "composio");
      return undefined;
    };

    return {
      capabilities,
      hostTools,
      policy,
      connections,
      world,
      serverTools,
      getAgent,
      approvals: createApprovalStore(),
      grants,
      audit,
      threads,
      threadIndex,
      resolveDescriptor,
      fadeTracker,
      clientTools,
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
      case "parked-actions": {
        if (!s.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return listParkedActionsRoute(req, { world: s.world, principal: guard.principal });
      }
      case "grants": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return listGrantsRoute(req, {
          grants: s.grants,
          world: s.world,
          principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId },
        });
      }
      case "audit": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return queryAuditRoute(req, { audit: s.audit, principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId } });
      }
      case "critical-tools": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        const names = [
          ...Object.keys(s.clientTools),
          ...Object.keys(s.serverTools()),
          ...(s.world ? Object.keys(s.world.authoringTools()) : []),
        ];
        return listCriticalToolsRoute(req, { toolNames: names, resolveDescriptor: s.resolveDescriptor });
      }
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
          threadIndex: s.threadIndex,
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
      case "consent": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return handleConsentRoute(req, {
          grants: s.grants,
          audit: s.audit,
          threads: s.threads,
          threadIndex: s.threadIndex,
          resolveDescriptor: s.resolveDescriptor,
          fadeTracker: s.fadeTracker,
          principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId },
        });
      }
      case "fade-proposal": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return handleFadeProposalRoute(req, {
          fadeTracker: s.fadeTracker,
          grants: s.grants,
          audit: s.audit,
          resolveDescriptor: s.resolveDescriptor,
          principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId },
        });
      }
      case "tick": {
        if (!s.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        await s.world.tick();
        return Response.json({ ok: true });
      }
      // POST /api/flowlet/parked-actions/resolve (ENG-193 §4.6) — `subPath`
      // only inspects the LAST path segment, so this is "resolve", not the
      // full mount path.
      case "resolve": {
        if (!s.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return resolveParkedActionRoute(req, { world: s.world, principal: guard.principal });
      }
      // POST /api/flowlet/grants/revoke (ENG-193 §3 Moment 12) — same
      // "last segment only" `subPath` behavior as parked-actions/resolve.
      case "revoke": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return revokeGrantRoute(req, {
          grants: s.grants,
          audit: s.audit,
          principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId },
        });
      }
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  return { GET, POST };
}
