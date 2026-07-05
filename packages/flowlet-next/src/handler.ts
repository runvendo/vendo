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
 *   GET  /rules         — Trust screen: compiled always-ask rules (ENG-193 item 6)
 *   POST /rules/revoke  — Trust screen: revoke a rule (ENG-193 item 6)
 *   GET  /audit         — Trust screen: audit query (ENG-193 §3 Moment 12)
 *   GET  /critical-tools — Trust screen: tools that always need the human (ENG-193 §3 Moment 12)
 *   POST /tick          — drives the automations scheduler
 *
 * ZERO-CONFIG: with no options it reads `.env` (capability-additive keys) and
 * `.flowlet/` (theme, tools manifest) and just works — ANTHROPIC_API_KEY alone
 * gives working chat + generated UI.
 */
import assert from "node:assert";
import type { ToolSet } from "ai";
import { prewiredComponents } from "@flowlet/components/descriptors";
import {
  buildDescriptor,
  createBreakerState,
  createConsentLedger,
  createFadeTracker,
  createInMemoryCompiledRuleStore,
  createInMemoryGrantStore,
  createSteeringTools,
  hostToolset,
  InMemoryAuditLog,
  InMemoryThreadStore,
} from "@flowlet/runtime";
import { handleChat } from "./chat";
import { handleAction, createApprovalStore } from "./action";
import { handleConsentRoute } from "./consent";
import { handleFadeProposalRoute } from "./fade-proposal";
import { listParkedActionsRoute, resolveParkedActionRoute } from "./parked-actions";
import { listGrantsRoute, revokeGrantRoute, listRulesRoute, revokeRuleRoute, queryAuditRoute, listCriticalToolsRoute } from "./trust";
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
    const rules = options.store?.rules ?? createInMemoryCompiledRuleStore();
    const audit = options.store?.audit ?? new InMemoryAuditLog();
    const threads = options.store?.threads ?? new InMemoryThreadStore(() => new Date().toISOString());
    const threadIndex = createThreadIndex(threads);
    const breakers = options.store?.breakers ?? createBreakerState();
    const fadeTracker = options.store?.fadeTracker ?? createFadeTracker();
    // Review follow-up: per-(principal, toolCallId) consent idempotency —
    // constructed ONCE here, alongside every other singleton dep this mount
    // owns (grants/audit/fadeTracker/breakers), not per-request. A duplicate
    // consent POST (double-click, client retry) would otherwise re-record a
    // fade decision, append another audit event, and attempt a second grant.
    const consentSeen = createConsentLedger();
    // ENG-193 item 2/3: the production stack wraps the host's base policy —
    // grants can suppress repeat approvals (never critical), a judge (off by
    // default) can tighten/loosen the act tier, deterministic breakers can
    // only tighten, and audit records executes.
    const basePolicy = options.policy ?? defaultFlowletPolicy;
    const policy = composeProductionPolicy(basePolicy, { grants, rules, audit, judgeModel: options.judgeModel, breakers });
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

    // ENG-193 item 6: steering tools merge into the same static "engine"
    // bucket automation authoring tools use — fixed embedded principal, same
    // single-tenant simplification world.ts documents. `resolveDescriptor` and
    // `knownToolNames` are forward references into this closure — safe,
    // `serverTools` is never CALLED until `assemble()` has fully run and all
    // three consts are bound (`resolveDescriptor` itself back-references
    // `serverTools()` already; `knownToolNames` does too, one line below).
    //
    // PRINCIPAL ASYMMETRY (review follow-up, item-6 plan's open-risks
    // section, now resolved below): the rest of this mount re-resolves the
    // Principal PER REQUEST — `resolvePrincipal(req, options)` maps whatever
    // identity the host's `options.principal` resolver returns into
    // `{ tenantId: EMBEDDED_TENANT, subject: guard.principal.userId }` fresh
    // on every grants/rules/audit/consent call (see the GET/POST handlers
    // below, and policy-stack.ts's `principalScope`). Steering tools do NOT:
    // they mint rules/grants under this ONE fixed `DEFAULT_PRINCIPAL`-derived
    // subject at construction time, identical to the single-tenant
    // simplification `world.ts` documents for automation authoring tools
    // (this bucket merges into that SAME static toolset). On a host with a
    // custom multi-tenant `principal` resolver, every user's "always ask
    // before"/"stop asking about" utterance would land on this ONE shared
    // identity instead of the caller's own — a false "Got it" for anyone but
    // DEFAULT_PRINCIPAL's subject. Until steering tools resolve their
    // principal per-request too (declared follow-up — needs a request-scoped
    // toolset, which this construction-time closure doesn't have), the safe
    // fix is to not register them at all on a custom-principal (multi-user)
    // mount; the default single-principal mount (no `principal` option)
    // keeps them, since DEFAULT_PRINCIPAL IS the one identity every request
    // on that mount runs as. The assertion below is a cheap sanity check
    // (not a multi-tenant guard) that the fixed identity this bucket relies
    // on is actually well-formed.
    assert(
      typeof DEFAULT_PRINCIPAL.userId === "string" && DEFAULT_PRINCIPAL.userId.length > 0,
      "steering tools require a non-empty fixed DEFAULT_PRINCIPAL.userId (single-tenant assumption, ENG-193 item-6)",
    );
    const serverTools = (): ToolSet => {
      const extra = typeof options.tools === "function" ? options.tools() : options.tools ?? {};
      return {
        ...extra,
        ...(world ? world.authoringTools() : {}),
        // Custom `options.principal` resolver -> multi-user mount -> steering
        // tools are withheld entirely (see the comment above).
        ...(options.principal === undefined
          ? createSteeringTools({
              principal: { tenantId: EMBEDDED_TENANT, subject: DEFAULT_PRINCIPAL.userId },
              rules, grants, audit,
              resolveDescriptor: (name) => resolveDescriptor(name),
              knownToolNames: () => knownToolNames(),
            })
          : {}),
      };
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

    // Every tool name registered on this mount RIGHT NOW: host + server +
    // automation-authoring (+ this steering bucket itself, via serverTools()).
    // Shared by the `GET /critical-tools` route below and by
    // `createSteeringTools`'s `always_ask_before` validation (review
    // follow-up, FALSE-ASSURANCE FIX in steering-tools.ts) — one list, one
    // definition. Does NOT include live Composio tool names beyond whatever
    // `serverTools()`/`clientTools` already carry: those are fetched
    // per-turn from Composio's MCP for the connected toolkits and are not
    // statically enumerable here, same pre-existing limitation the
    // `critical-tools` route already had.
    const knownToolNames = (): string[] => [
      ...Object.keys(clientTools),
      ...Object.keys(serverTools()),
      ...(world ? Object.keys(world.authoringTools()) : []),
    ];

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
      rules,
      audit,
      threads,
      threadIndex,
      resolveDescriptor,
      knownToolNames,
      fadeTracker,
      consentSeen,
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
      case "rules": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return listRulesRoute(req, { rules: s.rules, principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId } });
      }
      case "audit": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return queryAuditRoute(req, { audit: s.audit, principal: { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId } });
      }
      case "critical-tools": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return listCriticalToolsRoute(req, { toolNames: s.knownToolNames(), resolveDescriptor: s.resolveDescriptor });
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
          seen: s.consentSeen,
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
        // Guard against a future sibling route also ending in "resolve" (the
        // same trap the "revoke" case below already disambiguates).
        if (!new URL(req.url).pathname.includes("/parked-actions/resolve")) {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        if (!s.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        return resolveParkedActionRoute(req, { world: s.world, principal: guard.principal });
      }
      // POST /api/flowlet/grants/revoke AND POST /api/flowlet/rules/revoke
      // (ENG-193 §3 Moment 12/item-6) — `subPath` only inspects the LAST path
      // segment, so both collapse to "revoke" here; disambiguate on the full
      // pathname (item-6 plan deviation #6 — found while wiring this task).
      case "revoke": {
        const guard = await resolvePrincipal(req, options);
        if (!guard.ok) return guard.response;
        const principal = { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId };
        const isRuleRevoke = new URL(req.url).pathname.includes("/rules/revoke");
        return isRuleRevoke
          ? revokeRuleRoute(req, { rules: s.rules, audit: s.audit, principal })
          : revokeGrantRoute(req, { grants: s.grants, audit: s.audit, principal });
      }
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  return { GET, POST };
}
